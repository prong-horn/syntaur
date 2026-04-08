import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

interface SearchBarProps {
  active: boolean;
  query: string;
  onChange: (value: string) => void;
  resultCount: number;
}

export function SearchBar({ active, query, onChange, resultCount }: SearchBarProps) {
  if (!active && !query) {
    return (
      <Box paddingLeft={1}>
        <Text dimColor>/ to search</Text>
      </Box>
    );
  }

  return (
    <Box paddingLeft={1}>
      <Text color="yellow">/</Text>
      {active ? (
        <TextInput value={query} onChange={onChange} />
      ) : (
        <Text>{query}</Text>
      )}
      {query ? (
        <Text dimColor> ({resultCount} matches)</Text>
      ) : null}
    </Box>
  );
}
