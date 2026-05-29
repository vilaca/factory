import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { ELAPSED_SHOW_AFTER_MS, ELAPSED_TICK_MS, SPINNER_FRAME_MS } from './constants.js';

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
    }, SPINNER_FRAME_MS);
    const elapsedId = setInterval(() => {
      setElapsed(Date.now() - startedAt.current);
    }, ELAPSED_TICK_MS);
    return () => {
      clearInterval(frameId);
      clearInterval(elapsedId);
    };
  }, []);
  return (
    <Box>
      <Text color={color}>{SPINNER_FRAMES[frame]} </Text>
      <Text dimColor>{label}</Text>
      {elapsed >= ELAPSED_SHOW_AFTER_MS && <Text dimColor>{` ${formatElapsed(elapsed)}`}</Text>}
    </Box>
  );
}
