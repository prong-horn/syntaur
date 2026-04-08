export const statusColors: Record<string, string> = {
  pending: 'gray',
  in_progress: 'blue',
  blocked: 'red',
  review: 'yellow',
  completed: 'green',
  failed: 'red',
  active: 'blue',
  archived: 'gray',
};

export const priorityColors: Record<string, string> = {
  critical: 'red',
  high: 'yellow',
  medium: 'white',
  low: 'gray',
};

export function priorityIndicator(priority?: string): string {
  if (priority === 'critical') return '!!';
  if (priority === 'high') return '!';
  return '';
}
