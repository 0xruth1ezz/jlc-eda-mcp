const COMMAND_TIMEOUT_MS = 60_000;

export class BridgeClient {
  private commandUrl: string;

  constructor(commandUrl?: string) {
    this.commandUrl = commandUrl ?? resolveGatewayCommandUrl();
  }

  async connect(): Promise<void> {
    await this.command('ping');
  }

  async command(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS + 5_000);

    try {
      const response = await fetch(this.commandUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, params, timeoutMs: COMMAND_TIMEOUT_MS }),
        signal: controller.signal,
      });
      const body = await readJsonResponse(response);
      if (!response.ok || body?.ok === false) {
        throw new Error(String(body?.error || `Gateway request failed with HTTP ${response.status}`));
      }
      return body?.result;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Bridge command '${action}' timed out after ${COMMAND_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async disconnect(): Promise<void> {
    return Promise.resolve();
  }

  get isConnected(): boolean {
    return true;
  }
}

function resolveGatewayCommandUrl(): string {
  if (process.env.GATEWAY_HTTP_URL) {
    return process.env.GATEWAY_HTTP_URL;
  }

  if (process.env.GATEWAY_WS_URL) {
    try {
      const url = new URL(process.env.GATEWAY_WS_URL);
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
      url.pathname = '/command';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      // Fall through to the default URL.
    }
  }

  return 'http://127.0.0.1:18800/command';
}

async function readJsonResponse(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Gateway returned non-JSON response: ${text.slice(0, 200)}`);
  }
}
