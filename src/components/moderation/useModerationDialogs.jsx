import { useCallback, useState } from 'react';
import ReportDialog from './ReportDialog';
import BlockDialog from './BlockDialog';

/**
 * Report and Block for a page: `openReport(target, { name, blockTarget })`,
 * `openBlock(blockTarget, { name })`, and `dialogs` to render. A report with
 * a `blockTarget` offers to block that member once it is sent.
 *
 * @param {(blockTarget, result: { muted?: boolean }) => void} [onBlocked]
 * @param {(blockTarget) => void} [onNotMember]  hide a non-member on this device instead
 */
export function useModerationDialogs({ onBlocked, onNotMember } = {}) {
    const [dialog, setDialog] = useState(null);
    const close = useCallback(() => setDialog(null), []);
    const openReport = useCallback((target, { name, blockTarget } = {}) => setDialog({ kind: 'report', target, name, blockTarget }), []);
    const openBlock = useCallback((blockTarget, { name } = {}) => setDialog({ kind: 'block', blockTarget, name }), []);

    let dialogs = null;
    if (dialog?.kind === 'report') {
        dialogs = (
            <ReportDialog
                target={dialog.target}
                name={dialog.name}
                onClose={close}
                onBlock={dialog.blockTarget ? () => openBlock(dialog.blockTarget, { name: dialog.name }) : undefined}
            />
        );
    } else if (dialog?.kind === 'block') {
        dialogs = (
            <BlockDialog
                target={dialog.blockTarget}
                name={dialog.name}
                onClose={close}
                onBlocked={(result) => onBlocked?.(dialog.blockTarget, result)}
                onNotMember={onNotMember ? () => onNotMember(dialog.blockTarget) : undefined}
            />
        );
    }
    return { openReport, openBlock, dialogs };
}
