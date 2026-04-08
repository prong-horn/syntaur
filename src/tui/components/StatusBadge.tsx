import React from 'react';
import { Text } from 'ink';
import { statusColors } from '../colors.js';

interface StatusBadgeProps {
  status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const color = statusColors[status] ?? 'white';
  const label = status.replace('_', ' ');
  return <Text color={color}>{label}</Text>;
}
