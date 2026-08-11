import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Conversation, DeviceEngine } from '../api.js';
import { EnginePicker } from './EnginePicker.js';
import { ModelPicker } from './ModelPicker.js';
import { SessionPickerModal } from './SessionPickerModal.js';

interface NewConversationButtonProps {
  engines: DeviceEngine[];
  /** Paired session the agent session list and import are relayed through. */
  sessionId: string;
  /**
   * Engine the paired device runs by default, preselected when the dialog opens.
   * Ignored when the device no longer reports it among its engines.
   */
  defaultEngine?: string | undefined;
  disabled: boolean;
  /** Whether the paired machine is connected, which importing requires. */
  online: boolean;
  onCreate: (engine: string | undefined, model: string | undefined) => void;
  onImport: (conversation: Conversation) => void;
  onOpenModal?: (() => void) | undefined;
}

/**
 * Starts a conversation with a Modal dialog to choose Engine and Model.
 *
 * Both fields present their options in a SearchableSelect dropdown, matching the
 * composer ModelPicker, rather than a native select. This keeps the experience
 * consistent and allows filtering when the list is long.
 *
 * The device default is the preselected engine, since that is the one the user
 * configured for this machine and the sidebar no longer states it anywhere else.
 *
 * Rendered via createPortal to document.body so the modal is centered over the entire
 * viewport and free from CSS transform constraints of the mobile sidebar drawer.
 *
 * This dialog is also the way into the session picker. Continuing from an agent
 * session is another way of starting a conversation, so it is offered where the other
 * one is, and the two dialogs are shown one at a time rather than nested.
 */
export function NewConversationButton({
  engines,
  sessionId,
  defaultEngine,
  disabled,
  online,
  onCreate,
  onImport,
  onOpenModal,
}: NewConversationButtonProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [selectedEngine, setSelectedEngine] = useState<string>('');
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [pickerOpen, setPickerOpen] = useState(false);
  // Copied out of `selectedEngine` when the picker opens rather than read from it
  // later, so reopening this dialog behind the picker cannot change what the picker
  // is already listing.
  const [pickerEngine, setPickerEngine] = useState<string>('');

  useEffect(() => {
    if (open && engines.length > 0) {
      const initialEngine = engines.find((engine) => engine.name === defaultEngine) ?? engines[0];
      if (initialEngine !== undefined) {
        setSelectedEngine(initialEngine.name);
        setSelectedModel(initialEngine.models[0]?.id ?? '');
      }
    }
  }, [open, engines, defaultEngine]);

  const currentEngineObj = engines.find((e) => e.name === selectedEngine) ?? engines[0];
  const availableModels = currentEngineObj?.models ?? [];
  // The picker titles itself with the engine as its vendor writes it, while the CLI is
  // matched on the name. Falls back to the name if the device has stopped reporting
  // that engine, which is better than titling the dialog with nothing.
  const pickerLabel = engines.find((e) => e.name === pickerEngine)?.label ?? pickerEngine;

  const handleEngineChange = (engineName: string | undefined): void => {
    const name = engineName ?? '';
    setSelectedEngine(name);
    const targetEngine = engines.find((e) => e.name === name);
    setSelectedModel(targetEngine?.models[0]?.id ?? '');
  };

  const handleModelChange = (model: string | undefined): void => {
    setSelectedModel(model ?? '');
  };

  /**
   * Hands over to the session picker.
   *
   * This dialog closes on the way, because the picker replaces the choice it was
   * asking for: an imported conversation arrives with its engine already decided.
   */
  const handleContinueFromAgent = (): void => {
    setOpen(false);
    setPickerEngine(selectedEngine);
    setPickerOpen(true);
  };

  const handleConfirm = (): void => {
    setOpen(false);
    onCreate(
      selectedEngine !== '' ? selectedEngine : undefined,
      selectedModel !== '' ? selectedModel : undefined,
    );
  };

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const modal = open
    ? createPortal(
        <div
          className="modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setOpen(false);
            }
          }}
        >
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
            <div className="modal-header">
              <h3 id="modal-title">New Conversation</h3>
              <button
                type="button"
                className="btn-modal-close"
                aria-label="Close modal"
                onClick={() => {
                  setOpen(false);
                }}
              >
                ✕
              </button>
            </div>

            <div className="modal-body space-y-4">
              <EnginePicker
                engines={engines}
                selected={selectedEngine !== '' ? selectedEngine : undefined}
                disabled={engines.length === 0}
                onChange={handleEngineChange}
              />

              <ModelPicker
                id="modal-model"
                models={availableModels}
                selected={selectedModel !== '' ? selectedModel : undefined}
                disabled={availableModels.length === 0}
                onChange={handleModelChange}
                variant="field"
              />
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="btn-modal-cancel"
                onClick={() => {
                  setOpen(false);
                }}
              >
                Cancel
              </button>
              {/* Secondary styling, not the submit style: importing is the other way
                  out of this dialog, not the one it is here to offer. Absent entirely
                  when the machine reports no engines, since there would be nothing to
                  list sessions for. */}
              {engines.length > 0 && (
                <button
                  type="button"
                  className="btn-modal-cancel"
                  disabled={!online}
                  title={online ? undefined : 'Device must be online to import'}
                  onClick={handleContinueFromAgent}
                >
                  Continue from Agent
                </button>
              )}
              <button type="button" className="btn-modal-submit" onClick={handleConfirm}>
                Start Conversation
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        type="button"
        className="btn-new"
        disabled={disabled || engines.length === 0}
        onClick={() => {
          onOpenModal?.();
          setOpen(true);
        }}
      >
        <span aria-hidden="true" className="btn-new-icon">
          +
        </span>{' '}
        New
      </button>
      {modal}
      {pickerOpen && (
        <SessionPickerModal
          sessionId={sessionId}
          engine={pickerEngine}
          engineLabel={pickerLabel}
          online={online}
          onImport={onImport}
          onClose={() => {
            setPickerOpen(false);
          }}
        />
      )}
    </>
  );
}
