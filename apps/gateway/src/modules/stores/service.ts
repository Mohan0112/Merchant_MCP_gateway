import {
  CreateStoreRequestSchema,
  StoreSlugSchema,
  type CreateStoreRequest,
  type Store,
} from '@ahjin/contracts';
import {
  isConflict,
  storePath,
  storesPath,
  storeUpstreamSlug,
  STORE_GROUP,
  STORE_VERSION,
  type KubeClient,
  type StoreResource,
} from '@ahjin/kube';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as z from 'zod';
import type { GatewayContext } from '../../context';
import { upstreamServers } from '../../db/schema';
import { AppError, conflict, forbidden, notFound } from '../../lib/errors';
import { parse } from '../../lib/http';
import { requireUser, type Principal } from '../auth/principal';

export interface StoresOptions {
  /** null when store provisioning is switched off (no Kubernetes access for the gateway). */
  kube: KubeClient | null;
  namespace: string;
  maxPerUser: number;
}

const toDto = (store: StoreResource): Store => ({
  slug: store.metadata.name,
  name: store.spec.displayName,
  ownerId: store.spec.ownerId,
  ownerEmail: store.spec.ownerEmail,
  phase: store.metadata.deletionTimestamp ? 'Deleting' : (store.status?.phase ?? 'Provisioning'),
  step: store.status?.step || null,
  reason: store.status?.reason || null,
  message: store.status?.message || null,
  url: store.status?.url ?? null,
  upstreamSlug: storeUpstreamSlug(store.metadata.name),
  createdAt: store.metadata.creationTimestamp ?? null,
  readyAt: store.status?.readyAt ?? null,
});

/**
 * Stores as the dashboard sees them (Task 30). The gateway only creates, lists and deletes Store
 * resources in its own namespace (a Role limited to that); the store-operator does the rest.
 * Members see and manage their own stores; admins see everyone's.
 */
export class StoreService {
  constructor(
    private readonly ctx: GatewayContext,
    private readonly options: StoresOptions,
  ) {}

  private get kube(): KubeClient {
    if (!this.options.kube) {
      throw new AppError(404, 'not_enabled', 'Store provisioning is not enabled on this platform.');
    }
    return this.options.kube;
  }

  get enabled(): boolean {
    return this.options.kube !== null;
  }

  private async all(): Promise<StoreResource[]> {
    const { items } = await this.kube.get<{ items: StoreResource[] }>(
      storesPath(this.options.namespace),
    );
    return items;
  }

  private async one(viewer: Principal, slug: string): Promise<StoreResource> {
    const store = await this.kube.find<StoreResource>(storePath(this.options.namespace, slug));
    if (!store) throw notFound('Store');
    if (viewer.role !== 'admin' && store.spec.ownerId !== viewer.userId) throw notFound('Store');
    return store;
  }

  async list(viewer: Principal): Promise<Store[]> {
    const stores = await this.all();
    return stores
      .filter((s) => viewer.role === 'admin' || s.spec.ownerId === viewer.userId)
      .sort((a, b) =>
        (a.metadata.creationTimestamp ?? '').localeCompare(b.metadata.creationTimestamp ?? ''),
      )
      .map(toDto);
  }

  async create(viewer: Principal, input: CreateStoreRequest): Promise<Store> {
    const stores = await this.all();
    const mine = stores.filter((s) => s.spec.ownerId === viewer.userId);
    if (mine.length >= this.options.maxPerUser) {
      throw conflict(
        `You already have ${mine.length} store${mine.length === 1 ? '' : 's'}; the limit is ${this.options.maxPerUser}. Delete one first.`,
      );
    }
    if (stores.some((s) => s.metadata.name === input.slug)) {
      throw conflict(`A store with the address "${input.slug}" already exists.`);
    }
    const [taken] = await this.ctx.db
      .select({ id: upstreamServers.id })
      .from(upstreamServers)
      .where(eq(upstreamServers.slug, storeUpstreamSlug(input.slug)))
      .limit(1);
    if (taken) throw conflict(`The tool prefix "${storeUpstreamSlug(input.slug)}" is taken.`);

    try {
      const created = await this.kube.create<StoreResource>(storesPath(this.options.namespace), {
        apiVersion: `${STORE_GROUP}/${STORE_VERSION}`,
        kind: 'Store',
        metadata: {
          name: input.slug,
          labels: { 'ahjin.dev/owner': viewer.userId },
        },
        spec: { displayName: input.name, ownerId: viewer.userId, ownerEmail: viewer.email },
      });
      this.ctx.logger.info({ store: input.slug, owner: viewer.userId }, 'store requested');
      return toDto(created);
    } catch (error) {
      if (isConflict(error))
        throw conflict(`A store with the address "${input.slug}" already exists.`);
      throw error;
    }
  }

  /** Deleting the resource starts the operator's teardown (finalizer). */
  async remove(viewer: Principal, slug: string): Promise<void> {
    await this.one(viewer, slug);
    await this.kube.delete(storePath(this.options.namespace, slug));
    this.ctx.logger.info({ store: slug, by: viewer.userId }, 'store deletion requested');
  }

  /** A failed store starts over: bumping spec.retry makes the operator provision it again. */
  async retry(viewer: Principal, slug: string): Promise<Store> {
    const store = await this.one(viewer, slug);
    if (store.status?.phase !== 'Failed') throw conflict('Only a failed store can be retried.');
    const updated = await this.kube.patch<StoreResource>(storePath(this.options.namespace, slug), {
      spec: { retry: (store.spec.retry ?? 0) + 1 },
    });
    return toDto(updated);
  }
}

export function registerStoreRoutes(app: FastifyInstance, stores: StoreService) {
  const SlugParams = z.object({ slug: StoreSlugSchema });

  app.get('/api/stores', async (request) => {
    const viewer = requireUser(request);
    if (!stores.enabled) return { enabled: false, stores: [] };
    return { enabled: true, stores: await stores.list(viewer) };
  });

  app.post('/api/stores', async (request, reply) => {
    const viewer = requireUser(request);
    const store = await stores.create(viewer, parse(CreateStoreRequestSchema, request.body));
    return reply.code(201).send({ store });
  });

  app.delete('/api/stores/:slug', async (request, reply) => {
    const viewer = requireUser(request);
    await stores.remove(viewer, parse(SlugParams, request.params).slug);
    return reply.code(202).send();
  });

  app.post('/api/stores/:slug/retry', async (request) => {
    const viewer = requireUser(request);
    if (!stores.enabled) throw forbidden();
    return { store: await stores.retry(viewer, parse(SlugParams, request.params).slug) };
  });
}
