#!/usr/bin/env node
// Backups of the store and platform databases (Task 28; docs/runbooks/backup-and-restore.md).
//
//   node scripts/backup.mjs now                          # both, right away (from the CronJobs)
//   node scripts/backup.mjs list                         # what's in the backup volumes
//   node scripts/backup.mjs restore --component=store --name=20261022T103000Z.sql.gz
//   node scripts/backup.mjs restore --component=platform --name=latest
//   ... --context=<kube context> --namespace=<namespace>
//
// The chart takes backups nightly and before every helm upgrade (pre-upgrade hook). A restore
// stops the component's writers, loads the dump into the database, and starts them again.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const [command, ...rest] = process.argv.slice(2);
const args = Object.fromEntries(
  rest.map((arg) => {
    const [key, ...value] = arg.replace(/^--/, '').split('=');
    return [key, value.length ? value.join('=') : 'true'];
  }),
);
const context = args.context ?? 'k3d-ahjin';
const namespace = args.namespace ?? 'ahjin';

const kubectl = (argv, input) =>
  execFileSync('kubectl', ['--context', context, '-n', namespace, ...argv], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

/** Where each component's dumps live and how to load one back. */
const COMPONENTS = {
  store: {
    cronjob: 'store-backup',
    claim: 'store-backups',
    dir: 'mariadb',
    writers: [{ kind: 'deployment', name: 'wordpress' }],
    pausedCronjobs: ['wp-cron', 'store-backup'],
    // The MariaDB image's client, as the store's database user; the password comes from the Secret.
    image: () =>
      kubectl([
        'get',
        'statefulset/mariadb',
        '-o',
        'jsonpath={.spec.template.spec.containers[0].image}',
      ]),
    user: 999,
    env: [
      { name: 'MYSQL_PWD', valueFrom: { secretKeyRef: { name: 'store-db', key: 'password' } } },
    ],
    // The policy engine admits a new pod a moment after it starts: wait for the database first.
    ready:
      'for i in $(seq 1 20); do mariadb-admin --host=mariadb --user=wordpress ping >/dev/null 2>&1 && break; sleep 2; done',
    load: 'gunzip -c "$DUMP" | mariadb --host=mariadb --user=wordpress',
    label: 'store-backup',
  },
  platform: {
    cronjob: 'platform-backup',
    claim: 'platform-backups',
    dir: 'postgres',
    writers: [{ kind: 'deployment', name: 'gateway' }],
    pausedCronjobs: ['platform-backup'],
    image: () =>
      kubectl([
        'get',
        'statefulset/postgres',
        '-o',
        'jsonpath={.spec.template.spec.containers[0].image}',
      ]),
    user: 70,
    env: [
      { name: 'PGHOST', value: 'postgres' },
      { name: 'PGUSER', value: 'ahjin' },
      { name: 'PGDATABASE', value: 'ahjin' },
      { name: 'PGPASSWORD', valueFrom: { secretKeyRef: { name: 'platform-db', key: 'password' } } },
    ],
    ready: 'for i in $(seq 1 20); do pg_isready --quiet && break; sleep 2; done',
    load: 'gunzip -c "$DUMP" | psql --quiet --set ON_ERROR_STOP=1 >/dev/null',
    label: 'platform-backup',
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A one-off pod with a component's backup volume mounted, labelled so the NetworkPolicies admit it. */
async function runPod(component, name, script, extraEnv = []) {
  const c = COMPONENTS[component];
  const pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      labels: { 'app.kubernetes.io/name': c.label, 'app.kubernetes.io/part-of': 'ahjin' },
    },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: c.user,
        runAsGroup: c.user,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [
        {
          name: 'run',
          image: c.image(),
          command: ['sh', '-c', script],
          env: [...c.env, ...extraEnv],
          resources: {
            requests: { cpu: '50m', memory: '64Mi' },
            limits: { cpu: '1', memory: '512Mi' },
          },
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ['ALL'] },
          },
          volumeMounts: [
            { name: 'backups', mountPath: '/backups' },
            { name: 'tmp', mountPath: '/tmp' },
          ],
        },
      ],
      volumes: [
        { name: 'backups', persistentVolumeClaim: { claimName: c.claim } },
        { name: 'tmp', emptyDir: {} },
      ],
    },
  };
  kubectl(['apply', '-f', '-'], JSON.stringify(pod));
  const deadline = Date.now() + 600_000;
  let phase = '';
  while (!['Succeeded', 'Failed'].includes(phase) && Date.now() < deadline) {
    await sleep(2000);
    phase = kubectl(['get', 'pod', name, '-o', 'jsonpath={.status.phase}']);
  }
  const logs = phase === 'Succeeded' || phase === 'Failed' ? kubectl(['logs', name]) : '';
  kubectl(['delete', 'pod', name, '--wait=false']);
  if (phase !== 'Succeeded') {
    throw new Error(`${name} ended ${phase || 'without starting'}:\n${logs.slice(-2000)}`);
  }
  return logs;
}

async function now() {
  const run = randomBytes(3).toString('hex');
  for (const [component, c] of Object.entries(COMPONENTS)) {
    const job = `${c.cronjob}-manual-${run}`;
    kubectl(['create', 'job', job, `--from=cronjob/${c.cronjob}`]);
    kubectl(['wait', '--for=condition=Complete', `job/${job}`, '--timeout=600s']);
    console.log(
      `  ${component}: ${kubectl(['logs', `job/${job}`])
        .split('\n')
        .at(-1)}`,
    );
  }
}

async function list() {
  for (const [component, c] of Object.entries(COMPONENTS)) {
    const out = await runPod(
      component,
      `backup-list-${randomBytes(3).toString('hex')}`,
      `ls -1t /backups/${c.dir}/ 2>/dev/null | while read f; do echo "$f $(du -h /backups/${c.dir}/$f | cut -f1)"; done`,
    );
    console.log(`${component} (${c.claim}):`);
    console.log(out ? out.replace(/^/gm, '  ') : '  (none yet)');
  }
}

function scale(c, replicas) {
  for (const writer of c.writers) {
    kubectl(['scale', `${writer.kind}/${writer.name}`, `--replicas=${replicas}`]);
  }
  for (const cron of c.pausedCronjobs) {
    kubectl([
      'patch',
      `cronjob/${cron}`,
      '-p',
      JSON.stringify({ spec: { suspend: replicas === 0 } }),
    ]);
  }
}

async function restore() {
  const component = args.component;
  const c = COMPONENTS[component];
  if (!c) throw new Error('--component=store or --component=platform');
  const wanted = args.name ?? 'latest';
  const pick =
    wanted === 'latest'
      ? `DUMP=$(ls -1t /backups/${c.dir}/*.sql.gz | head -1)`
      : `DUMP=/backups/${c.dir}/${wanted.replace(/[^A-Za-z0-9._-]/g, '')}`;
  const replicas = kubectl([
    'get',
    `${c.writers[0].kind}/${c.writers[0].name}`,
    '-o',
    'jsonpath={.spec.replicas}',
  ]);
  console.log(
    `Restoring ${component} from ${wanted}: stopping ${c.writers.map((w) => w.name).join(', ')}`,
  );
  scale(c, 0);
  try {
    for (const writer of c.writers) {
      kubectl(['rollout', 'status', `${writer.kind}/${writer.name}`, '--timeout=120s']);
    }
    const out = await runPod(
      component,
      `backup-restore-${randomBytes(3).toString('hex')}`,
      `set -eu; ${pick}; test -f "$DUMP"; ${c.ready}; echo "loading $DUMP"; ${c.load}; echo restored`,
    );
    console.log(out.replace(/^/gm, '  '));
  } finally {
    scale(c, Number(replicas) || 1);
    for (const writer of c.writers) {
      kubectl(['rollout', 'status', `${writer.kind}/${writer.name}`, '--timeout=300s']);
    }
    console.log(`  ${c.writers.map((w) => w.name).join(', ')} running again`);
  }
}

const commands = { now, list, restore };
if (!commands[command]) {
  console.error(
    'usage: node scripts/backup.mjs now | list | restore --component=store|platform [--name=<file>|latest]',
  );
  process.exit(2);
}
await commands[command]();
