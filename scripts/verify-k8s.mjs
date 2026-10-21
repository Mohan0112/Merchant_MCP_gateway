#!/usr/bin/env node
// Static checks on the rendered Helm chart, for every environment's values (task verify:k8s, CI).
//
//   node scripts/verify-k8s.mjs                      # local and production values, plus kubeconform
//   node scripts/verify-k8s.mjs --no-kubeconform     # skip schema validation (no Docker needed)
//   node scripts/verify-k8s.mjs --values=a.yaml,b.yaml   # one extra render with these values files
//
// (local, production, and production + rehearsal). It fails when a long-running container has no readiness or liveness probe, when any container
// (init containers, Jobs and CronJobs included) lacks CPU and memory requests and limits, when a pod
// may run as root or keeps privilege escalation or capabilities, when NetworkPolicies are on but a
// Service's pods aren't admitted by an allow policy or the namespace default deny is missing, and
// when a values file holds what looks like a secret instead of a Secret's name.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse, parseAllDocuments } from 'yaml';

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    return [key, rest.length ? rest.join('=') : 'true'];
  }),
);
const CHART = 'charts/ahjin';
const KUBECONFORM = 'ghcr.io/yannh/kubeconform:v0.8.0';
const KUBERNETES_VERSION = '1.35.0';

const renders = [
  { name: 'local', values: [`${CHART}/values-local.yaml`] },
  { name: 'prod', values: [`${CHART}/values-prod.yaml`] },
  { name: 'rehearsal', values: [`${CHART}/values-prod.yaml`, `${CHART}/values-rehearsal.yaml`] },
];
if (args.values) renders.push({ name: 'custom', values: args.values.split(',') });

const problems = [];
const problem = (render, message) => problems.push(`[${render}] ${message}`);

// ---------- rendering ----------

function helmTemplate(values) {
  return execFileSync(
    'helm',
    ['template', 'ahjin', CHART, '-n', 'ahjin', ...values.flatMap((file) => ['-f', file])],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
}

/** The pod spec and kind of every workload in a rendered manifest list. */
function podSpecs(objects) {
  const specs = [];
  for (const object of objects) {
    const name = `${object.kind}/${object.metadata?.name}`;
    const template =
      object.kind === 'CronJob' ? object.spec?.jobTemplate?.spec?.template : object.spec?.template;
    if (['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'].includes(object.kind)) {
      specs.push({
        name,
        longRunning: !['Job', 'CronJob'].includes(object.kind),
        labels: template?.metadata?.labels ?? {},
        spec: template?.spec ?? {},
      });
    }
  }
  return specs;
}

const matches = (selector = {}, labels = {}) =>
  Object.entries(selector).every(([key, value]) => labels[key] === value);

// ---------- checks ----------

function checkWorkloads(render, workloads) {
  for (const { name, longRunning, spec } of workloads) {
    const pod = spec.securityContext ?? {};
    const containers = [
      ...(spec.initContainers ?? []).map((c) => ({ ...c, init: true })),
      ...(spec.containers ?? []),
    ];
    for (const container of containers) {
      const where = `${name} ${container.init ? 'init container' : 'container'} ${container.name}`;
      if (longRunning && !container.init) {
        if (!container.readinessProbe) problem(render, `${where} has no readinessProbe`);
        if (!container.livenessProbe) problem(render, `${where} has no livenessProbe`);
      }
      const { requests = {}, limits = {} } = container.resources ?? {};
      for (const [kind, set] of [
        ['requests', requests],
        ['limits', limits],
      ]) {
        for (const resource of ['cpu', 'memory']) {
          if (!set[resource]) problem(render, `${where} has no ${resource} ${kind}`);
        }
      }
      const security = container.securityContext ?? {};
      if (!(security.runAsNonRoot ?? pod.runAsNonRoot)) {
        problem(render, `${where} may run as root (runAsNonRoot not set)`);
      }
      if (security.allowPrivilegeEscalation !== false) {
        problem(render, `${where} doesn't set allowPrivilegeEscalation: false`);
      }
      if (!(security.capabilities?.drop ?? []).includes('ALL')) {
        problem(render, `${where} doesn't drop ALL capabilities`);
      }
      const seccomp = security.seccompProfile?.type ?? pod.seccompProfile?.type;
      if (seccomp !== 'RuntimeDefault')
        problem(render, `${where} has no RuntimeDefault seccomp profile`);
    }
  }
}

function checkNetworkPolicies(render, objects, workloads) {
  const policies = objects.filter((o) => o.kind === 'NetworkPolicy');
  if (policies.length === 0) {
    console.log(`  [${render}] NetworkPolicies are switched off; skipping the policy checks`);
    return;
  }
  const defaultDeny = policies.some(
    (p) =>
      Object.keys(p.spec?.podSelector ?? {}).length === 0 &&
      (p.spec?.policyTypes ?? []).includes('Ingress') &&
      !(p.spec?.ingress ?? []).length,
  );
  if (!defaultDeny) problem(render, 'no namespace-wide default-deny ingress NetworkPolicy');

  const allowPolicies = policies.filter((p) => (p.spec?.ingress ?? []).length > 0);
  for (const policy of allowPolicies) {
    for (const rule of policy.spec.ingress) {
      if (!(rule.from ?? []).length) {
        problem(
          render,
          `NetworkPolicy/${policy.metadata.name} has a rule without sources (admits everyone)`,
        );
      }
      for (const peer of rule.from ?? []) {
        if (peer.namespaceSelector && !peer.podSelector) {
          problem(render, `NetworkPolicy/${policy.metadata.name} admits every pod of a namespace`);
        }
      }
      if (!(rule.ports ?? []).length) {
        problem(
          render,
          `NetworkPolicy/${policy.metadata.name} has a rule without port restrictions`,
        );
      }
    }
  }
  // Every pod behind a Service must be admitted by some allow policy, or the Service is dead.
  for (const service of objects.filter((o) => o.kind === 'Service')) {
    const selector = service.spec?.selector;
    if (!selector) continue;
    for (const workload of workloads.filter((w) => matches(selector, w.labels))) {
      const admitted = allowPolicies.some((p) =>
        matches(p.spec.podSelector?.matchLabels, workload.labels),
      );
      if (!admitted) {
        problem(
          render,
          `${workload.name} (behind Service/${service.metadata.name}) has no allow policy`,
        );
      }
    }
  }
}

// Values hold Secret *names* and keys only (ADR-0008); a literal under a secret-like key is a leak.
const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|pepper|salt|private/i;
const K8S_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

function checkValuesFiles() {
  const files = [
    ...readdirSync(CHART)
      .filter((f) => /^values.*\.ya?ml$/.test(f))
      .map((f) => join(CHART, f)),
    ...readdirSync(join(CHART, 'charts')).map((sub) => join(CHART, 'charts', sub, 'values.yaml')),
  ];
  for (const file of files) {
    const walk = (node, path) => {
      if (Array.isArray(node)) node.forEach((item, i) => walk(item, `${path}[${i}]`));
      else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) walk(value, path ? `${path}.${key}` : key);
      } else if (typeof node === 'string' && node !== '') {
        const key = path
          .split('.')
          .pop()
          .replace(/\[\d+\]$/, '');
        if (SECRET_KEY.test(key) && !K8S_NAME.test(node)) {
          problem(
            'values',
            `${file}: ${path} looks like a secret value; reference a Secret instead`,
          );
        }
      }
    };
    walk(parse(readFileSync(file, 'utf8')), '');
  }
}

function kubeconform(render, manifests) {
  try {
    const out = execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '-i',
        KUBECONFORM,
        '-strict',
        '-summary',
        '-ignore-missing-schemas',
        '-kubernetes-version',
        KUBERNETES_VERSION,
        '-',
      ],
      { input: manifests, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    console.log(`  [${render}] kubeconform: ${out.trim().split('\n').pop()}`);
  } catch (error) {
    problem(render, `kubeconform failed:\n${(error.stdout || error.message).trim()}`);
  }
}

// ---------- run ----------

console.log('Verifying the rendered chart');
checkValuesFiles();
for (const { name, values } of renders) {
  const manifests = helmTemplate(values);
  const objects = parseAllDocuments(manifests)
    .map((doc) => doc.toJSON())
    .filter((object) => object?.kind);
  const workloads = podSpecs(objects);
  console.log(
    `  [${name}] ${objects.length} objects, ${workloads.length} workloads (${values.join(' + ')})`,
  );
  checkWorkloads(name, workloads);
  checkNetworkPolicies(name, objects, workloads);
  if (args['no-kubeconform'] !== 'true') kubeconform(name, manifests);
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ✘ ${p}`);
  process.exit(1);
}
console.log('\nAll checks passed.');
