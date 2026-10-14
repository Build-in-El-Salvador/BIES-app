import React, { useState, useRef, useLayoutEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useBottomNav } from '../context/BottomNavContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import usePointerDrag from '../hooks/usePointerDrag';
import useFlipLayout from '../hooks/useFlipLayout';
import { NAV_PAGES, NAV_PAGES_BY_ID, MAX_TABS, MIN_TABS } from '../config/navPages';

const clamp = (n, min, max) => Math.min(Math.max(n, min), max);
const sameOrder = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Phone-homescreen style customizer for the mobile bottom navbar
 * (route: /settings/navbar). Drag page icons from the grid into the
 * 5-slot dock; drag dock icons out to remove them. Tapping (or Enter/Space)
 * is the non-drag fallback: grid icon → append to dock, dock icon → remove.
 * Auto-saves on every committed change via BottomNavContext. All icon
 * movement (reorder, insert, evict, grid reflow, ghost → slot landing) is
 * animated by one generalized FLIP pass (useFlipLayout).
 */
const CustomizeNavbar = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { tabs, updateTabs, resetTabs, isCustomized, saveError } = useBottomNav();

    const dockRef = useRef(null);
    const gridRef = useRef(null);
    const hoverIndexRef = useRef(null); // mirrors hoverIndex for synchronous reads on drop
    const slotWidthRef = useRef(0); // dock slot width, refreshed on every drag move
    const [hoverIndex, setHoverIndex] = useState(null);
    const [flybackId, setFlybackId] = useState(null); // icon kept hidden while its ghost flies home

    const { capture, play } = useFlipLayout([gridRef, dockRef]);

    // Play the FLIP captured just before the commit, right after both sections re-lay-out.
    useLayoutEffect(() => {
        play();
    }, [tabs, play]);

    // Runtime feature toggles: disabled pages are hidden from both the dock
    // and the grid so they can't be added (or seen) while off. The stored tab
    // ids are untouched — re-enabling the feature restores the user's dock.
    const { flags } = useFeatureFlags();
    const featureOn = (p) => !p.flag || flags[p.flag] !== false;

    const dockPages = tabs.map((id) => NAV_PAGES_BY_ID[id]).filter(Boolean).filter(featureOn);
    const gridPages = NAV_PAGES.filter((p) => !tabs.includes(p.id)).filter(featureOn);

    const setHover = (idx) => {
        if (idx !== hoverIndexRef.current) {
            hoverIndexRef.current = idx;
            setHoverIndex(idx);
        }
    };

    const handleDragMove = ({ id, source, x, y }) => {
        const dock = dockRef.current;
        if (!dock) return;
        const r = dock.getBoundingClientRect();
        slotWidthRef.current = r.width / MAX_TABS;
        const over = y >= r.top - 16 && y <= r.bottom + 8 && x >= r.left && x <= r.right;
        if (!over) {
            setHover(null);
            return;
        }
        // The dock always renders MAX_TABS equal slots, so derive the hovered
        // slot from that geometry; clamping to the visible count makes every
        // empty placeholder mean "append".
        const visible = source === 'dock' ? tabs.filter((tid) => tid !== id) : tabs;
        const slot = Math.floor(((x - r.left) / r.width) * MAX_TABS);
        setHover(clamp(slot, 0, visible.length));
    };

    /** Fly the drag ghost back onto its source icon (cancelled / no-op drop). */
    const flyGhostBack = (id, source) => {
        const ghost = ghostRef.current;
        const container = source === 'dock' ? dockRef.current : gridRef.current;
        const target = container ? container.querySelector('[data-page-id="' + id + '"]') : null;
        if (!ghost || !target) return;
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const to = target.getBoundingClientRect();
        const naturalWidth = ghost.offsetWidth;
        const scale = naturalWidth > 0 ? to.width / naturalWidth : 1;
        // The clone keeps the ghost's classes (styled-jsx scoped) and its
        // current inline transform, so it starts exactly under the finger and
        // survives the real ghost unmounting on the next commit.
        const clone = ghost.cloneNode(true);
        document.body.appendChild(clone);
        setFlybackId(id); // hide the source icon while its clone flies home
        clone.getBoundingClientRect(); // commit the start position before transitioning
        clone.style.transition = 'transform 0.25s cubic-bezier(0.2, 0, 0, 1)';
        clone.style.transform = 'translate3d(' + to.left + 'px, ' + to.top + 'px, 0) scale(' + scale + ')';
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            target.style.opacity = ''; // restore before the clone vanishes — no blank frame
            clone.remove();
            setFlybackId((cur) => (cur === id ? null : cur));
        };
        clone.addEventListener('transitionend', finish);
        clone.addEventListener('transitioncancel', finish);
        setTimeout(finish, 400); // safety net if the transition never fires
    };

    const handleDragEnd = ({ id, source }) => {
        const idx = hoverIndexRef.current;
        let next = null;
        if (idx !== null) {
            // Dropped onto the dock: insert at idx, evicting the rightmost icon if full.
            const base = source === 'dock' ? tabs.filter((tid) => tid !== id) : [...tabs];
            if (base.length >= MAX_TABS) base.pop();
            base.splice(Math.min(idx, base.length), 0, id);
            next = base;
        } else if (source === 'dock' && tabs.length > MIN_TABS) {
            // Dragged out of the dock: remove.
            next = tabs.filter((tid) => tid !== id);
        }
        if (next && !sameOrder(next, tabs)) {
            // The dropped icon FLIPs from under the finger (the ghost's rect,
            // scale included) into its destination slot; every other icon
            // FLIPs from its pre-commit rect. The ghost unmounts on the same
            // commit, so there is no double image.
            const ghostRect = ghostRef.current ? ghostRef.current.getBoundingClientRect() : null;
            capture(ghostRect ? { [id]: ghostRect } : undefined);
            updateTabs(next);
        } else {
            // Invalid or no-op drop (outside the dock from the grid, last tab,
            // or same slot): the ghost flies back onto its source icon.
            flyGhostBack(id, source);
        }
        setHover(null);
    };

    const handleDragCancel = ({ id, source } = {}) => {
        if (id) flyGhostBack(id, source);
        setHover(null);
    };

    const { dragging, ghostRef, startDrag, consumeDrag } = usePointerDrag({
        onDragMove: handleDragMove,
        onDragEnd: handleDragEnd,
        onDragCancel: handleDragCancel,
    });

    // Tap / Enter / Space fallback: grid icon → append to the dock (evicting
    // the rightmost when full); dock icon → remove (respecting MIN_TABS).
    const handleGridTap = (id) => {
        const next = [...tabs];
        if (next.length >= MAX_TABS) next.pop();
        next.push(id);
        capture();
        updateTabs(next);
    };

    const handleDockTap = (id) => {
        if (tabs.length <= MIN_TABS) return;
        capture();
        updateTabs(tabs.filter((tid) => tid !== id));
    };

    const handleReset = () => {
        if (!isCustomized) return;
        capture();
        resetTabs();
    };

    const draggedDockId = dragging && dragging.source === 'dock' ? dragging.id : null;
    const visibleDockIds = draggedDockId ? tabs.filter((tid) => tid !== draggedDockId) : tabs;
    const slotWidth = slotWidthRef.current;

    const ghostPage = dragging ? NAV_PAGES_BY_ID[dragging.id] : null;
    const GhostIcon = ghostPage ? ghostPage.icon : null;

    return (
        <div className="container customize-page" style={{ paddingTop: 'var(--page-top, 1.5rem)' }}>
            <div className="customize-header">
                <button type="button" className="back-btn" aria-label={t('common.back')} onClick={() => navigate(-1)}>
                    <ChevronLeft size={22} />
                </button>
                <h1>{t('customNav.title')}</h1>
                <button type="button" className="reset-btn" data-testid="nav-reset" onClick={handleReset}>
                    <RotateCcw size={15} />
                    <span>{t('customNav.reset')}</span>
                </button>
            </div>
            <p className="subtitle">{t('customNav.subtitle')}</p>
            {saveError && (
                <p className="save-error" role="status">
                    {t('customNav.saveError', {
                        defaultValue: 'Could not sync to your account — changes are saved on this device only.',
                    })}
                </p>
            )}
            <p className="desktop-note">{t('customNav.desktopNote')}</p>

            <div className="phone-frame">
                <div className="icon-grid" ref={gridRef}>
                    {gridPages.map((p) => {
                        const Icon = p.icon;
                        const isDragged = dragging !== null && dragging.id === p.id;
                        const style = isDragged
                            ? { opacity: 0.35 }
                            : flybackId === p.id
                                ? { opacity: 0 }
                                : undefined;
                        return (
                            <button
                                key={p.id}
                                type="button"
                                className="grid-icon"
                                data-testid={'grid-icon-' + p.id}
                                data-page-id={p.id}
                                aria-label={t('customNav.addTabAria', {
                                    defaultValue: 'Add {{page}} to the bottom bar',
                                    page: t(p.labelKey),
                                })}
                                onPointerDown={(e) => startDrag(e, p.id, 'grid')}
                                onClick={() => {
                                    if (!consumeDrag()) handleGridTap(p.id);
                                }}
                                style={style}
                            >
                                <span className="grid-tile"><Icon size={26} strokeWidth={1.8} /></span>
                                <span className="grid-label">{t(p.labelKey)}</span>
                            </button>
                        );
                    })}
                </div>

                <div className={'dock' + (dragging ? ' dock-dragging' : '')} ref={dockRef} data-testid="nav-dock">
                    {Array.from({ length: MAX_TABS }, (_, i) => {
                        const page = dockPages[i];
                        if (!page) {
                            return (
                                <div key={'empty-' + i} className="dock-slot">
                                    <span className="dock-placeholder" />
                                </div>
                            );
                        }
                        const Icon = page.icon;
                        const isDragged = page.id === draggedDockId;
                        // Gap opening with true slot geometry: while hovering,
                        // every non-dragged icon shifts to the exact slot it
                        // will occupy after the drop, so committing the drop
                        // causes no visible jump for the bystanders.
                        let transform = 'none';
                        if (hoverIndex !== null && !isDragged && slotWidth) {
                            const vIdx = visibleDockIds.indexOf(page.id);
                            const finalIdx = vIdx < hoverIndex ? vIdx : vIdx + 1;
                            const shift = (finalIdx - i) * slotWidth;
                            if (shift) transform = 'translateX(' + shift + 'px)';
                        }
                        return (
                            <div key={page.id} className="dock-slot">
                                <button
                                    type="button"
                                    className="dock-icon"
                                    data-testid={'dock-icon-' + page.id}
                                    data-page-id={page.id}
                                    aria-label={t('customNav.removeTabAria', {
                                        defaultValue: 'Remove {{page}} from the bottom bar',
                                        page: t(page.labelKey),
                                    })}
                                    onPointerDown={(e) => startDrag(e, page.id, 'dock')}
                                    onClick={() => {
                                        if (!consumeDrag()) handleDockTap(page.id);
                                    }}
                                    // Use opacity (not visibility:hidden) while dragging: the drag
                                    // hook keeps its listeners + pointer capture on this element, and
                                    // a non-hit-testable element releases capture and aborts the drag.
                                    style={{ transform, opacity: isDragged || flybackId === page.id ? 0 : 1 }}
                                >
                                    <span className="dock-icon-wrap"><Icon size={22} strokeWidth={1.8} /></span>
                                    <span className="dock-label">{t(page.labelKey)}</span>
                                </button>
                            </div>
                        );
                    })}
                </div>
            </div>

            {ghostPage && (
                <div ref={ghostRef} className="drag-ghost" data-testid="drag-ghost">
                    <span className="ghost-tile">{GhostIcon && <GhostIcon size={26} strokeWidth={1.8} />}</span>
                    <span className="ghost-label">{t(ghostPage.labelKey)}</span>
                </div>
            )}

            <style jsx>{`
                .customize-page { max-width: 48rem; padding-bottom: 3rem; }

                .customize-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem; }
                .customize-header h1 { flex: 1; font-size: 1.5rem; margin: 0; }
                .back-btn { display: flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: var(--radius-full); border: 1px solid var(--color-gray-200); background: var(--color-surface); color: var(--color-gray-700); cursor: pointer; flex-shrink: 0; }
                .back-btn:hover { background: var(--color-gray-100); }
                .reset-btn { display: flex; align-items: center; gap: 0.4rem; padding: 0.5rem 0.9rem; border-radius: var(--radius-full); border: 1px solid var(--color-gray-300); background: var(--color-surface); color: var(--color-gray-600); font-size: 0.85rem; font-weight: 600; cursor: pointer; white-space: nowrap; }
                .reset-btn:hover { border-color: var(--color-secondary); color: var(--color-secondary); }

                .subtitle { color: var(--color-gray-500); font-size: 0.9rem; margin-bottom: 0.25rem; }
                .save-error { color: var(--color-error, #EF4444); font-size: 0.8rem; margin-bottom: 0.25rem; }
                .desktop-note { display: none; }
                @media (min-width: 769px) {
                    .desktop-note { display: block; color: var(--color-gray-400); font-size: 0.8rem; margin-bottom: 0.25rem; }
                }

                .phone-frame {
                    position: relative;
                    max-width: 390px;
                    margin: 1rem auto 0;
                    border: 8px solid var(--color-gray-800);
                    border-radius: 40px;
                    min-height: 640px;
                    background: var(--color-surface);
                    overflow: hidden;
                    padding: 1.5rem 0.75rem calc(110px + env(safe-area-inset-bottom, 0px));
                    box-shadow: var(--shadow-lg);
                }
                @media (max-width: 768px) {
                    .phone-frame {
                        border: none;
                        border-radius: 0;
                        max-width: none;
                        margin: 0.5rem 0 0;
                        box-shadow: none;
                        /* Size to content and place the dock in normal flow so it is
                           always on-screen and draggable — a fixed 640px frame with an
                           absolutely-pinned dock pushes the dock below the viewport. */
                        min-height: 0;
                        padding-bottom: 1rem;
                    }
                    /* Higher specificity than the later base dock rule, so the dock
                       renders in-flow below the grid instead of overlapping it. */
                    .phone-frame .dock {
                        position: static;
                        /* full-bleed to the frame edges (frame has 0.75rem side padding) */
                        margin: 1.25rem -0.75rem 0;
                    }
                }

                .icon-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1.25rem 0.5rem; }

                .grid-icon,
                .dock-icon {
                    /* pan-y keeps vertical page scrolling alive on touch; the drag
                       hook claims the gesture only after the 150ms lift hold. */
                    touch-action: pan-y;
                    user-select: none;
                    -webkit-user-select: none;
                    -webkit-touch-callout: none;
                    cursor: grab;
                    background: none;
                    border: none;
                    padding: 0;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    font-family: inherit;
                }
                .grid-icon:active,
                .dock-icon:active { cursor: grabbing; }

                .grid-icon { gap: 4px; color: var(--color-gray-700); }
                .grid-tile {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 56px;
                    height: 56px;
                    border-radius: var(--radius-lg);
                    background: var(--color-gray-100);
                    color: var(--color-primary);
                    box-shadow: var(--shadow-sm);
                }
                .grid-label { font-size: 0.68rem; font-weight: 500; letter-spacing: 0.03em; max-width: 72px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

                .dock {
                    position: absolute;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    display: flex;
                    align-items: flex-start;
                    justify-content: space-around;
                    background: var(--color-primary-nav, var(--color-primary));
                    border-top: 3px solid #FF5B00;
                    padding-top: 10px;
                    padding-bottom: calc(6px + env(safe-area-inset-bottom, 0px));
                }
                .dock-slot { flex: 1; display: flex; align-items: flex-start; justify-content: center; min-width: 0; }
                .dock-icon { gap: 3px; color: white; font-size: 0.68rem; font-weight: 500; letter-spacing: 0.03em; }
                /* Gap-opening shifts ease only WHILE a drag is in flight; on drop the
                   class disappears in the same commit, so clearing the shift is
                   instant and the FLIP pass measures true (untransitioned) rects. */
                .dock-dragging .dock-icon { transition: transform 0.2s ease; }
                .dock-icon-wrap {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 40px;
                    height: 32px;
                    border-radius: 16px;
                }
                .dock-icon:hover .dock-icon-wrap { color: #FF5B00; background: rgba(255, 91, 0, 0.15); }
                .dock-label { max-width: 64px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .dock-placeholder { display: block; width: 40px; height: 32px; border-radius: 16px; border: 2px dashed rgba(255, 255, 255, 0.4); }

                .drag-ghost {
                    position: fixed;
                    left: 0;
                    top: 0;
                    z-index: 10001;
                    pointer-events: none;
                    will-change: transform;
                    transform: translate3d(-1000px, -1000px, 0);
                    /* top-left origin so the grab-offset + scale math lines up */
                    transform-origin: top left;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 4px;
                }
                .ghost-tile {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 56px;
                    height: 56px;
                    border-radius: var(--radius-lg);
                    background: var(--color-surface);
                    color: var(--color-primary);
                    border: 2px solid var(--color-secondary);
                    box-shadow: var(--shadow-lg);
                }
                .ghost-label {
                    font-size: 0.7rem;
                    font-weight: 600;
                    color: var(--color-gray-700);
                    background: var(--color-surface);
                    padding: 1px 6px;
                    border-radius: var(--radius-full);
                    box-shadow: var(--shadow-sm);
                }

                @media (prefers-reduced-motion: reduce) {
                    .dock-dragging .dock-icon { transition: none; }
                }
            `}</style>
        </div>
    );
};

export default CustomizeNavbar;
