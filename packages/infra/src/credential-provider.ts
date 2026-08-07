export interface CredentialProvider {
  getApiKey(tenant: string, provider: string): Promise<string | null>;
}

export class EnvCredentialProvider implements CredentialProvider {
  private envMap: Record<string, string>;

  constructor() {
    this.envMap = {
      anthropic: "PI_ANTHROPIC_API_KEY",
      openai: "PI_OPENAI_API_KEY",
      google: "PI_GOOGLE_API_KEY",
      openrouter: "PI_OPENROUTER_API_KEY",
    };
  }

  async getApiKey(_tenant: string, provider: string): Promise<string | null> {
    const envVar = this.envMap[provider];
    if (!envVar) return null;
    return process.env[envVar] ?? null;
  }
}
