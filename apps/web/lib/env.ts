function normalizeEnvValue(value: string | undefined): string | undefined {
  return value?.trim().replace(/\\n/g, '');
}

export function getRequiredEnv(name: string): string {
  const value = normalizeEnvValue(process.env[name]);
  if (!value) {
    throw new Error(`Missing ${name} environment variable`);
  }
  return value;
}

export function getOptionalEnv(name: string): string | undefined {
  return normalizeEnvValue(process.env[name]);
}
