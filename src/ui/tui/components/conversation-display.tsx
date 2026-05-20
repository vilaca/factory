import React from 'react';
import { Box, Static } from 'ink';
import type { DisplayItem } from '../types.js';
import type { ToolCallSummary } from '../types.js';
import { DisplayItemView, ToolCallLine } from './display-item-view.js';
import { AssistantText } from './assistant-text.js';
import { Spinner } from './spinner.js';
import { Separator } from './separator.js';

interface ConversationDisplayProps {
  items: DisplayItem[];
  streamingText: string;
  /** Tool call rendered live in the dynamic region while we wait for the
   * permission decision / execution to resolve. Once resolved it's flushed
   * into items[] (and thus Static) as the final tool-call entry. */
  pendingToolCall?: ToolCallSummary | null;
  spinner?: { label: string; color: string };
  /** Ink only supports one <Static> instance per render tree (its reconciler
   * tracks a single staticNode). With multiple tabs mounted concurrently, we
   * fall back to a plain map for all sessions. Single-tab keeps Static so the
   * existing scrollback UX is preserved. */
  useStatic?: boolean;
  /** When on, tool-result items render the full output instead of the
   * preview. Toggled via /full. */
  showFullOutput?: boolean;
  /** When on, assistant prompt is 🤖 and user prompt is 🧑🏻‍💻. Toggled via /emoji. */
  emojiMode?: boolean;
  /** Custom user emoji from `/emoji <glyph>`. Falls back to 🧑🏻‍💻 when
   *  undefined. Ignored while emojiMode is off. */
  userEmoji?: string;
}

/**
 * Items committed to <Static> get written to the terminal once and live in
 * its real scrollback — that's what lets the user scroll up while the model
 * is still streaming. A single outer Box around <Static> wouldn't work
 * (Static items are flushed above any dynamic parent), so each item gets
 * its own padded Box and turns are split by an inline <Separator />.
 */
function PanelLine({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Box paddingX={1} width="100%">
      {children}
    </Box>
  );
}

/** True when `items[index]` is a tool-call whose immediate predecessor is a
 *  tool-call of the same tool — i.e. nothing else (text, result panel,
 *  notice) has interrupted the run. The renderer uses this to suppress the
 *  repeated `🔧 ToolName:` header. */
function isToolCallContinuation(items: DisplayItem[], index: number): boolean {
  if (index === 0) return false;
  const cur = items[index];
  const prev = items[index - 1];
  if (!cur || !prev) return false;
  return cur.kind === 'tool-call' && prev.kind === 'tool-call' && prev.toolName === cur.toolName;
}

/** True when `items[index]` is a tool-call whose matching tool-result is the
 *  immediately following item and reports failure. The renderer uses this to
 *  swap `🔧` for `✗` on the call header so failures are visible at the top
 *  instead of only on the result panel. Successful results are often filtered
 *  out (see event-handler `isNoise`), so absence of a following result means
 *  "succeeded", not "still pending" — by the time items[] reaches Static, the
 *  tool-call-result event has already fired. */
function isToolCallFailed(items: DisplayItem[], index: number): boolean {
  const cur = items[index];
  const next = items[index + 1];
  if (!cur || cur.kind !== 'tool-call') return false;
  if (!next || next.kind !== 'tool-result') return false;
  if (next.toolName !== cur.toolName) return false;
  return !next.success;
}

export function ConversationDisplay({
  items,
  streamingText,
  pendingToolCall,
  spinner,
  useStatic = true,
  showFullOutput = false,
  emojiMode = false,
  userEmoji,
}: ConversationDisplayProps): React.ReactElement {
  const renderItem = (item: DisplayItem, index: number): React.ReactElement => {
    const continuation = isToolCallContinuation(items, index);
    const failed = isToolCallFailed(items, index);
    return (
      <React.Fragment key={item.id}>
        {index > 0 && !continuation && <Separator />}
        <PanelLine>
          <DisplayItemView
            item={item}
            showFullOutput={showFullOutput}
            emojiMode={emojiMode}
            userEmoji={userEmoji}
            continuation={continuation}
            failed={failed}
          />
        </PanelLine>
      </React.Fragment>
    );
  };
  return (
    <Box flexDirection="column">
      {useStatic ? (
        <Static items={items}>{(item, index) => renderItem(item, index)}</Static>
      ) : (
        items.map((item, index) => renderItem(item, index))
      )}
      {streamingText && (
        <>
          {items.length > 0 && <Separator />}
          <PanelLine>
            <AssistantText text={streamingText} streaming={true} emojiMode={emojiMode} />
          </PanelLine>
        </>
      )}
      {pendingToolCall &&
        (() => {
          const last = items[items.length - 1];
          const pendingContinuation =
            !streamingText &&
            !!last &&
            last.kind === 'tool-call' &&
            last.toolName === pendingToolCall.toolName;
          return (
            <>
              {items.length > 0 && !streamingText && !pendingContinuation && <Separator />}
              <PanelLine>
                <ToolCallLine
                  icon="🔧"
                  toolName={pendingToolCall.toolName}
                  args={pendingToolCall.args}
                  continuation={pendingContinuation}
                />
              </PanelLine>
            </>
          );
        })()}
      {spinner && (
        <>
          {items.length > 0 && !streamingText && !pendingToolCall && <Separator />}
          <PanelLine>
            <Spinner label={spinner.label} color={spinner.color} />
          </PanelLine>
        </>
      )}
    </Box>
  );
}
