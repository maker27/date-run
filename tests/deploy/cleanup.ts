export interface CleanupResource {
  name: string;
  cleanup(): Promise<void>;
}

export async function cleanupOwnedResources(resources: readonly CleanupResource[]): Promise<void> {
  const errors: Error[] = [];
  for (const resource of resources) {
    try {
      await resource.cleanup();
    } catch (error) {
      errors.push(new Error(`Failed to clean ${resource.name}`, { cause: error }));
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Owned resource cleanup failed');
}
