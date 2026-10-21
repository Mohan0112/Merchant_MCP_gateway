import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A Helm command that failed, with the end of its output (never values: they hold no secrets anyway). */
export class HelmError extends Error {
  override name = 'HelmError';
}

export interface ReleaseStatus {
  /** deployed, failed, pending-install, pending-upgrade, pending-rollback, uninstalling, … */
  status: string;
  revision: number;
}

/** What the reconciler needs from Helm; tests substitute a fake. */
export interface HelmPort {
  status(release: string, namespace: string): Promise<ReleaseStatus | null>;
  upgradeInstall(
    release: string,
    namespace: string,
    chart: string,
    values: unknown,
    timeoutSeconds: number,
  ): Promise<void>;
  uninstall(release: string, namespace: string): Promise<void>;
}

/** The helm binary in the image, using the pod's service account (in-cluster config). */
export class HelmCli implements HelmPort {
  constructor(private readonly bin = 'helm') {}

  private run(args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.bin,
        args,
        { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: process.env },
        (error, stdout, stderr) => {
          if (error) {
            const output = `${stderr}\n${stdout}`.trim().split('\n').slice(-6).join(' | ');
            reject(
              new HelmError(`helm ${args[0]} failed: ${output || error.message}`.slice(0, 900)),
            );
          } else resolve(stdout);
        },
      );
    });
  }

  async status(release: string, namespace: string): Promise<ReleaseStatus | null> {
    try {
      const out = await this.run(['status', release, '-n', namespace, '-o', 'json'], 30_000);
      const parsed = JSON.parse(out) as { info?: { status?: string }; version?: number };
      return { status: parsed.info?.status ?? 'unknown', revision: parsed.version ?? 0 };
    } catch (error) {
      if (error instanceof HelmError && /not found/i.test(error.message)) return null;
      throw error;
    }
  }

  async upgradeInstall(
    release: string,
    namespace: string,
    chart: string,
    values: unknown,
    timeoutSeconds: number,
  ): Promise<void> {
    const file = join(tmpdir(), `values-${release}-${randomBytes(4).toString('hex')}.json`);
    await writeFile(file, JSON.stringify(values), { mode: 0o600 });
    try {
      await this.run(
        [
          'upgrade',
          '--install',
          release,
          chart,
          '-n',
          namespace,
          '-f',
          file,
          '--wait',
          '--timeout',
          `${Math.max(60, Math.floor(timeoutSeconds))}s`,
        ],
        (timeoutSeconds + 60) * 1000,
      );
    } finally {
      await rm(file, { force: true });
    }
  }

  async uninstall(release: string, namespace: string): Promise<void> {
    try {
      await this.run(
        ['uninstall', release, '-n', namespace, '--wait', '--timeout', '180s'],
        240_000,
      );
    } catch (error) {
      if (error instanceof HelmError && /not found/i.test(error.message)) return;
      throw error;
    }
  }
}
