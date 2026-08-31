interface AutopilotToggleProps {
  /** True while this conversation answers its own asks. */
  enabled: boolean;
  /**
   * True when the switch cannot be reached: no conversation open, or a device that
   * is away. An answer has to reach the machine to mean anything.
   */
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
}

/**
 * Turns autopilot on and off for the conversation on screen.
 *
 * Beside the prompt rather than in the sidebar, because this is part of sending
 * work: the question it answers is "may this one carry on without me", and it is
 * asked at the moment the work is handed over.
 *
 * A switch rather than a button, because it is a state and not an action. A button
 * says something happens when it is pressed; this one says something keeps happening
 * until it is turned back. The track is what carries that: the position is readable
 * without the label, which is what a control the user is trusting with approvals
 * needs to be.
 *
 * Deliberately not the same thing as Always allow on an approval card. That records
 * a rule on the machine which outlives every conversation on it; this covers only
 * this conversation and stops the moment it is switched off. See ADR-059.
 */
export function AutopilotToggle({
  enabled,
  disabled = false,
  onChange,
}: AutopilotToggleProps): React.JSX.Element {
  return (
    <button
      type="button"
      // The role the state belongs to: a switch reports aria-checked, which is read
      // out as on or off rather than as a button that happens to be held down.
      role="switch"
      aria-checked={enabled}
      className={enabled ? 'autopilot on' : 'autopilot'}
      disabled={disabled}
      // Named in full for anyone who cannot see the track, since the word beside it
      // says what the control is and only the track says which way it is set.
      aria-label={enabled ? 'Autopilot on. Turn off to be asked again.' : 'Turn autopilot on'}
      title={
        enabled
          ? 'Tool calls in this conversation are approved automatically.'
          : 'Approve tool calls in this conversation automatically.'
      }
      onClick={() => {
        onChange(!enabled);
      }}
    >
      <span className="autopilot-label">Autopilot</span>
      {/* Inert to assistive technology: the state is already on the button itself,
          and announcing the track as well would say it twice. */}
      <span className="autopilot-track" aria-hidden="true">
        <span className="autopilot-knob" />
      </span>
    </button>
  );
}
