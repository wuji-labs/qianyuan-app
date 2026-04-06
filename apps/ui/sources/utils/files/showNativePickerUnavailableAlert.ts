import { Modal } from '@/modal';
import { t } from '@/text';

function readErrorDetail(error: unknown): string | null {
    if (error instanceof Error) {
        const message = error.message.trim();
        return message.length > 0 ? message : null;
    }
    if (typeof error === 'string') {
        const message = error.trim();
        return message.length > 0 ? message : null;
    }
    return null;
}

export function showNativePickerUnavailableAlert(error?: unknown): void {
    const detail = readErrorDetail(error);
    const body = detail
        ? `${t('attachments.alerts.pickerUnavailableBody')}\n\n${detail}`
        : t('attachments.alerts.pickerUnavailableBody');

    Modal.alert(t('common.error'), body);
}

