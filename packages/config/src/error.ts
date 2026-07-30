/**
 * Raised when a config file exists but cannot be parsed or fails validation.
 * Carries the file path so the CLI can point the user at the exact file.
 */
export class ConfigError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = 'ConfigError';
    this.path = path;
  }
}
