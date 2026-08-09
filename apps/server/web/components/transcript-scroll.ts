import { useLayoutEffect, useRef } from 'react';

/**
 * Where the transcript is scrolled to.
 *
 * Two rules, and one place that owns both, because they are the same question asked at
 * different moments: a conversation is opened at its end, and an answer is followed
 * while the reader is watching it.
 */
interface TranscriptState {
  /**
   * The conversation on screen.
   *
   * Opening one places the view at its end, so a change here is the signal to do it
   * again. Undefined is a transcript with no conversation behind it, which is placed
   * once like any other.
   */
  conversationId: string | undefined;
  /** Whether there is anything to scroll to at all. */
  loaded: boolean;
  /**
   * Whether stored history has arrived, as opposed to only streaming text.
   *
   * A conversation opened mid-answer renders the answer first and its history a moment
   * later, and the end moves when that history lands underneath.
   */
  stored: boolean;
}

/**
 * Whether the reader can see the end of the transcript.
 *
 * Measured from the live row when a turn is answering, because that row is the end: it
 * is always last while output arrives, so having it on screen is the same as being at
 * the bottom, and measuring the row itself needs no guess at how many pixels from the
 * end still count as the end. With nothing arriving the scroll position answers the
 * same question, give or take the fraction of a pixel a zoomed page and a scaled
 * screen leave behind.
 */
function atEnd(container: HTMLElement, live: HTMLElement | null): boolean {
  if (live !== null) {
    const view = container.getBoundingClientRect();
    const row = live.getBoundingClientRect();

    return row.top < view.bottom && row.bottom > view.top;
  }

  return container.scrollHeight - container.scrollTop - container.clientHeight <= 2;
}

/**
 * Keeps the transcript where a reader would expect to find it.
 *
 * Opening a conversation lands at its end: the last answer is what a reload came back
 * for, and the history above it is there to be scrolled back to. Done once per
 * conversation, in a layout effect so the view is at the end before the browser paints
 * and nothing is seen travelling down the screen, and repeated on the next frame
 * because a height can still settle after that paint.
 *
 * An answer arriving is followed for as long as its live row is on screen. That row
 * says what the turn is doing and sits at the end, so each new paragraph or tool
 * result pushes it below the fold, and a reader watching the answer had to keep
 * scrolling to stay with it. A reader who has scrolled up is doing the opposite, and
 * dragging them back on every fragment is what made an answer impossible to read back
 * while it ran. Scrolling to the end again resumes it.
 *
 * The rule is only reconsidered when the reader scrolls, which is what keeps the two
 * cases apart: arriving output fires no scroll of its own, so what is read here is
 * where the reader had put the view rather than where the output has just pushed the
 * row to.
 */
export function useTranscriptScroll(
  containerRef: React.RefObject<HTMLDivElement | null>,
  liveRef: React.RefObject<HTMLDivElement | null>,
  { conversationId, loaded, stored }: TranscriptState,
): () => void {
  const following = useRef(true);
  // Holds which conversation was placed and whether its history had arrived by then,
  // rather than a flag, so another conversation is placed at its end too and one
  // opened mid-answer is placed again when its history lands.
  const placed = useRef<{ id: string | undefined; stored: boolean } | undefined>(undefined);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const done = placed.current;

    // Nothing has arrived yet, so there is no end to go to. The transcript is fetched
    // after the conversation is opened, and this runs again when it lands.
    if (container === null || !loaded) {
      return;
    }

    if (done !== undefined && done.id === conversationId && (done.stored || !stored)) {
      return;
    }

    placed.current = { id: conversationId, stored };

    const toEnd = (): void => {
      container.scrollTop = container.scrollHeight;
      // The view is now at the end, whatever the reader had done in the conversation
      // they came from, so an answer arriving in this one is theirs to watch.
      following.current = true;
    };

    toEnd();

    const frame = requestAnimationFrame(toEnd);

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [containerRef, conversationId, loaded, stored]);

  // No dependencies: this runs for whatever changed the transcript, and the decision
  // is the ref rather than the render.
  useLayoutEffect(() => {
    const container = containerRef.current;

    if (container === null || !following.current) {
      return;
    }

    container.scrollTop = container.scrollHeight;
  });

  /**
   * Handles the reader scrolling, and is bound as a prop rather than by hand.
   *
   * Attaching a listener to the element meant attaching it to whichever element
   * existed when the effect first ran, and on a page being loaded that is none of
   * them: the transcript is empty until the history arrives, so the scroll container
   * is not in the document yet. Nothing then ever told this that the reader had
   * scrolled away, and the answer was followed for the rest of the turn however far
   * up they had gone. A prop is bound to whatever element is there.
   */
  return () => {
    const container = containerRef.current;

    if (container !== null) {
      following.current = atEnd(container, liveRef.current);
    }
  };
}
