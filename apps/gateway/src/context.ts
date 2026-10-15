import type { Logger } from '@urumi/logger';
import type { Database } from './db/client';

/** Everything a feature module needs, passed explicitly (no globals), so tests can swap any part. */
export interface GatewayContext {
  db: Database;
  logger: Logger;
  settings: {
    /** Server-side secret mixed into API key hashes (Secret gateway-crypto). */
    apiKeyPepper: string;
    /** Secure cookies when the public URL is https. */
    cookieSecure: boolean;
    /** Public URL of the dashboard, used to build invitation links. */
    publicBaseUrl: string;
  };
  now: () => Date;
}
