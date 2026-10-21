import {
  inClusterConfig,
  KubeClient,
  storePath,
  storesPath,
  type StoreResource,
  type StoreStatus,
} from '@ahjin/kube';
import { createLogger } from '@ahjin/logger';
import { createServer } from 'node:http';
import { loadBaseValues, loadConfig } from './config';
import { GatewayClient } from './gateway';
import { HelmCli } from './helm';
import { StoreReconciler, type StoreApi } from './reconciler';
import { StoreResources } from './resources';

/** Store resources through the Kubernetes API (status and finalizers as merge patches). */
class KubeStoreApi implements StoreApi {
  constructor(
    private readonly kube: KubeClient,
    private readonly namespace: string,
  ) {}

  async list(): Promise<StoreResource[]> {
    const { items } = await this.kube.get<{ items: StoreResource[] }>(storesPath(this.namespace));
    return items;
  }

  async patchStatus(name: string, status: StoreStatus): Promise<void> {
    await this.kube.patch(`${storePath(this.namespace, name)}/status`, { status });
  }

  async setFinalizers(name: string, finalizers: string[]): Promise<void> {
    await this.kube.patch(storePath(this.namespace, name), { metadata: { finalizers } });
  }
}

async function main() {
  const logger = createLogger('store-operator');
  const config = loadConfig();
  const kube = new KubeClient(inClusterConfig());
  const reconciler = new StoreReconciler({
    stores: new KubeStoreApi(kube, config.NAMESPACE),
    resources: new StoreResources(kube),
    helm: new HelmCli(config.HELM_BIN),
    gateway: new GatewayClient(config.GATEWAY_URL, config.INTERNAL_TOKEN),
    logger,
    baseValues: loadBaseValues(config.STORE_VALUES_FILE),
    chartPath: config.CHART_PATH,
    provisionTimeoutMs: config.PROVISION_TIMEOUT_MS,
    maxParallel: config.MAX_PARALLEL,
  });

  // Ready once a pass has reached the Kubernetes API; live as long as passes keep completing.
  let lastPass = 0;
  let healthy = false;
  const loop = async () => {
    try {
      await reconciler.tick();
      healthy = true;
      lastPass = Date.now();
    } catch (error) {
      healthy = false;
      logger.error({ err: error }, 'could not list Store resources');
    }
  };
  const timer = setInterval(() => void loop(), config.RECONCILE_INTERVAL_MS);
  await loop();

  const server = createServer((req, res) => {
    const stale = Date.now() - lastPass > config.RECONCILE_INTERVAL_MS * 12;
    if (req.url === '/livez') {
      res.writeHead(stale ? 503 : 200).end(stale ? 'stalled' : 'ok');
    } else if (req.url === '/readyz') {
      res.writeHead(healthy ? 200 : 503).end(healthy ? 'ready' : 'not ready');
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(config.PORT, '0.0.0.0');
  logger.info({ namespace: config.NAMESPACE, busy: reconciler.busy() }, 'store operator started');

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      // In-flight Helm runs are cut; the next operator pod resumes them (level-based).
      logger.info({ signal, busy: reconciler.busy() }, 'shutting down');
      clearInterval(timer);
      server.close(() => process.exit(0));
    });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
