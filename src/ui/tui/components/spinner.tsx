import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  return `${minutes}m${remSec.toString().padStart(2, '0')}s`;
}

export function Spinner({ label, color }: { label: string; color: string }): React.ReactElement {
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(Date.now());
  useEffect(() => {
    const frameId = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER_FRAMES.length);
    }, 80);
    const elapsedId = setInterval(() => {
      setElapsed(Date.now() - startedAt.current);
    }, 1000);
    return () => {
      clearInterval(frameId);
      clearInterval(elapsedId);
    };
  }, []);
  return (
    <Box>
      <Text color={color}>{SPINNER_FRAMES[frame]} </Text>
      <Text dimColor>{label}</Text>
      {elapsed >= 1000 && <Text dimColor>{` ${formatElapsed(elapsed)}`}</Text>}
    </Box>
  );
}
