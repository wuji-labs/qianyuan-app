const DESKTOP_PET_OVERLAY_ROUTE = '/desktop/pet-overlay';

export function shouldRenderDesktopUpdateBannerForRoute(pathname: string | null | undefined): boolean {
    if (!pathname) return true;

    const [route] = pathname.split('?');
    return route.replace(/\/+$/, '') !== DESKTOP_PET_OVERLAY_ROUTE;
}
