// Maintenance refusals are fixed RuntimeMaintenance messages; bound them and
// strip anything credential-shaped before they leave the owner socket.
export const maintenanceReason = error => String(error?.message ?? 'Unknown maintenance refusal.')
  .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/[A-Za-z0-9+/_=-]{48,}/g, '[redacted]').slice(0, 300);
