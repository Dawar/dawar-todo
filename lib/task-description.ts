export const MAX_TASK_DESCRIPTION_LENGTH = 500_000;

export function validateTaskDescription(value: string) {
  if (value.length > MAX_TASK_DESCRIPTION_LENGTH) {
    throw new Error("Task descriptions are limited to 500,000 characters.");
  }
  return value;
}
