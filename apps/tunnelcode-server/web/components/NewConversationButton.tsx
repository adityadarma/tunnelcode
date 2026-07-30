import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DeviceEngine } from '../api.js';

interface NewConversationButtonProps {
  engines: DeviceEngine[];
  disabled: boolean;
  onCreate: (engine: string | undefined, model: string | undefined) => void;
  onOpenModal?: (() => void) | undefined;
}

/**
 * Starts a conversation with a Modal dialog to choose Engine and Model.
 *
 * Rendered via createPortal to document.body so the modal is centered over the entire
 * viewport and free from CSS transform constraints of the mobile sidebar drawer.
 */
export function NewConversationButton({
  engines,
  disabled,
  onCreate,
  onOpenModal,
}: NewConversationButtonProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [selectedEngine, setSelectedEngine] = useState<string>('');
  const [selectedModel, setSelectedModel] = useState<string>('');

  useEffect(() => {
    if (open && engines.length > 0) {
      const initialEngine = engines[0];
      if (initialEngine !== undefined) {
        setSelectedEngine(initialEngine.name);
        setSelectedModel(initialEngine.models[0] ?? '');
      }
    }
  }, [open, engines]);

  const currentEngineObj = engines.find((e) => e.name === selectedEngine) ?? engines[0];
  const availableModels = currentEngineObj?.models ?? [];

  const handleEngineChange = (engineName: string): void => {
    setSelectedEngine(engineName);
    const targetEngine = engines.find((e) => e.name === engineName);
    setSelectedModel(targetEngine?.models[0] ?? '');
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
              <div className="form-group">
                <label htmlFor="modal-engine">Engine</label>
                <select
                  id="modal-engine"
                  value={selectedEngine}
                  onChange={(e) => {
                    handleEngineChange(e.target.value);
                  }}
                >
                  {engines.map((engine) => (
                    <option key={engine.name} value={engine.name}>
                      {engine.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="modal-model">Model</label>
                <select
                  id="modal-model"
                  value={selectedModel}
                  disabled={availableModels.length === 0}
                  onChange={(e) => {
                    setSelectedModel(e.target.value);
                  }}
                >
                  {availableModels.length === 0 ? (
                    <option value="">Engine default</option>
                  ) : (
                    availableModels.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))
                  )}
                </select>
              </div>
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
    </>
  );
}
