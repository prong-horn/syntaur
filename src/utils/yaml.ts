export function escapeYamlString(value: string): string {
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error(
      `YAML string values must be single-line. Got: "${value.slice(0, 50)}..."`,
    );
  }
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}
