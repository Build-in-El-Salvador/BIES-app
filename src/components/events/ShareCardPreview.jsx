import { useLayoutEffect, useRef } from 'react';
import CoverPhoto from '../CoverPhoto';
import logo from '../../assets/logo-horizontal-mono-white.svg';
import { cardText } from '../../utils/shareCard';

// In English, as the picture itself is (the server draws it in English).
const LABELS = { community: 'Community event', proposed: 'Proposed meetup' };

/**
 * What a shared event's link shows in WhatsApp, as the server draws it
 * (server/src/services/shareCard.service.ts; sizes here are its pixels as a
 * share of the card's width: --cq is a hundredth of it, measured here, as
 * iOS 15 has no cqw). The name and place leave out what the card's font
 * can't draw (emoji), as the server does. A BIES event: its cover, square, as it
 * is. Any other: the wide card, its words on the dark left and the cover on
 * the right. No cover: the words on navy with the orange ring.
 *
 * @param {'square'|'wide'} props.format - utils/shareCard.js shareFormat
 * @param {''|'community'|'proposed'} [props.label]
 * @param {string} props.title
 * @param {string} [props.date] - utils/shareCard.js cardDate
 * @param {string} [props.venue]
 * @param {string} [props.extra] - how it repeats, or what a meetup needs
 * @param {string} [props.cover]
 * @param {string} [props.frame] - the cover's position for the card
 */
export default function ShareCardPreview({ format, label = '', title, date = '', venue = '', extra = '', cover = '', frame = '' }) {
    const square = format === 'square';
    const poster = square && cover; // a BIES event's poster has its own words
    const name = cardText(title);
    const place = cardText(venue);
    const cardRef = useRef(null);

    // A hundredth of the card's width, for the sizes below: what 1cqw is, on iOS 15 too.
    useLayoutEffect(() => {
        const el = cardRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const measure = () => el.style.setProperty('--cq', `${el.clientWidth / 100}px`);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    return (
        <div ref={cardRef} className={`scp${square ? ' sq' : ''}${cover ? '' : ' none'}`} aria-hidden="true">
            {cover && (
                <span className="scp-photo">
                    <CoverPhoto src={cover} frame={frame} dim={square ? undefined : 0.42} />
                </span>
            )}
            {cover && !square && <span className="scp-shade" />}
            {!cover && <span className="scp-ring" />}
            {!poster && (
                <span className="scp-text">
                    <span className="scp-top">
                        <img className="scp-logo" src={logo} alt="" />
                        {LABELS[label] && <span className={`scp-kind${label === 'proposed' ? ' prop' : ''}`}>{LABELS[label]}</span>}
                    </span>
                    <span className="scp-title">{name}</span>
                    <span className="scp-rule" />
                    {date && <span className="scp-date">{date}</span>}
                    {place && <span className="scp-venue">{place}</span>}
                    {extra && <span className="scp-extra">{extra}</span>}
                </span>
            )}
            <style jsx>{`
                .scp {
                    position: relative; display: block; width: 100%; aspect-ratio: 1200 / 630; container-type: inline-size;
                    overflow: hidden; border-radius: 12px; clip-path: inset(0 round 12px); background: #0B0E18; color: #FFFFFF;
                }
                .scp.sq { aspect-ratio: 1 / 1; }
                .scp.none { background: radial-gradient(circle calc(125 * var(--cq, 1cqw)) at 100% 0, #24306F 0, #121E5A calc(52.5 * var(--cq, 1cqw)), #0A0F2E calc(125 * var(--cq, 1cqw))); }
                .scp-photo { position: absolute; top: 0; right: 0; bottom: 0; left: 34%; overflow: hidden; }
                .scp.sq .scp-photo { left: 0; }
                .scp-shade {
                    position: absolute; top: 0; right: 0; bottom: 0; left: 0;
                    background: linear-gradient(90deg, rgba(11, 14, 24, 1) 0%, rgba(11, 14, 24, 1) 34%, rgba(11, 14, 24, 0.62) 46%, rgba(11, 14, 24, 0.14) 66%, rgba(11, 14, 24, 0) 80%);
                }
                .scp-ring {
                    position: absolute; left: calc(64 * var(--cq, 1cqw)); top: calc(22.5 * var(--cq, 1cqw)); width: calc(46 * var(--cq, 1cqw)); height: calc(46 * var(--cq, 1cqw));
                    border: calc(2.17 * var(--cq, 1cqw)) solid #FF5B00; border-radius: 50%; box-sizing: border-box;
                }
                .scp.sq .scp-ring { left: calc(57.96 * var(--cq, 1cqw)); top: calc(57.96 * var(--cq, 1cqw)); width: calc(64.07 * var(--cq, 1cqw)); height: calc(64.07 * var(--cq, 1cqw)); border-width: calc(2.96 * var(--cq, 1cqw)); }
                .scp-text {
                    position: absolute; left: calc(5 * var(--cq, 1cqw)); top: 0; bottom: 0; width: calc(55 * var(--cq, 1cqw));
                    display: flex; flex-direction: column; justify-content: center; align-items: flex-start;
                }
                .scp.sq .scp-text { left: calc(7.96 * var(--cq, 1cqw)); width: calc(83.3 * var(--cq, 1cqw)); }
                .scp-top { display: flex; align-items: center; gap: calc(2 * var(--cq, 1cqw)); margin-bottom: calc(2.83 * var(--cq, 1cqw)); }
                .scp.sq .scp-top { margin-bottom: calc(5 * var(--cq, 1cqw)); }
                .scp-logo { display: block; height: calc(5.17 * var(--cq, 1cqw)); width: auto; max-width: none; }
                .scp.sq .scp-logo { height: calc(8.15 * var(--cq, 1cqw)); }
                .scp-kind {
                    font: 700 calc(1.58 * var(--cq, 1cqw))/1 var(--font-sans); letter-spacing: 0.14em; text-transform: uppercase; white-space: nowrap;
                    padding: calc(0.83 * var(--cq, 1cqw)) calc(1.17 * var(--cq, 1cqw)); border: calc(0.17 * var(--cq, 1cqw)) solid rgba(255, 255, 255, 0.72);
                }
                .scp-kind.prop { color: #FF5B00; border-color: #FF5B00; }
                .scp-title {
                    font: 400 calc(7.42 * var(--cq, 1cqw))/0.98 'DM Serif Display', Georgia, serif; max-width: calc(46.67 * var(--cq, 1cqw)); overflow-wrap: anywhere;
                    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
                }
                .scp.sq .scp-title { font-size: calc(12.04 * var(--cq, 1cqw)); max-width: calc(79.6 * var(--cq, 1cqw)); -webkit-line-clamp: 3; }
                .scp-rule { display: block; width: calc(30 * var(--cq, 1cqw)); height: calc(0.17 * var(--cq, 1cqw)); margin: calc(2 * var(--cq, 1cqw)) 0; background: rgba(246, 206, 133, 0.75); }
                .scp.sq .scp-rule { width: calc(44 * var(--cq, 1cqw)); height: calc(0.23 * var(--cq, 1cqw)); margin: calc(3.43 * var(--cq, 1cqw)) 0; }
                .scp-date { font: 600 calc(2.17 * var(--cq, 1cqw))/1 var(--font-sans); letter-spacing: 0.14em; text-transform: uppercase; white-space: nowrap; }
                .scp.sq .scp-date { font-size: calc(3.33 * var(--cq, 1cqw)); }
                .scp-venue {
                    font: 400 calc(4.5 * var(--cq, 1cqw))/1.05 'DM Serif Display', Georgia, serif; color: #F6CE85; margin-top: calc(1.17 * var(--cq, 1cqw));
                    max-width: calc(46.67 * var(--cq, 1cqw)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                }
                .scp.sq .scp-venue { font-size: calc(7.04 * var(--cq, 1cqw)); margin-top: calc(1.85 * var(--cq, 1cqw)); max-width: calc(79.6 * var(--cq, 1cqw)); }
                .scp-extra {
                    font: 700 calc(1.83 * var(--cq, 1cqw))/1 var(--font-sans); letter-spacing: 0.12em; text-transform: uppercase; white-space: nowrap;
                    color: #FF5B00; margin-top: calc(1.67 * var(--cq, 1cqw));
                }
                .scp.sq .scp-extra { font-size: calc(2.78 * var(--cq, 1cqw)); margin-top: calc(2.78 * var(--cq, 1cqw)); }
            `}</style>
        </div>
    );
}
