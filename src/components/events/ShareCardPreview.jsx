import CoverPhoto from '../CoverPhoto';
import logo from '../../assets/logo-horizontal-mono-white.svg';

// In English, as the picture itself is (the server draws it in English).
const LABELS = { community: 'Community event', proposed: 'Proposed meetup' };

/**
 * What a shared event's link shows in WhatsApp, as the server draws it
 * (server/src/services/shareCard.service.ts; sizes here are its pixels as a
 * share of the card's width, in cqw). A BIES event: its cover, square, as it
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
    return (
        <div className={`scp${square ? ' sq' : ''}${cover ? '' : ' none'}`} aria-hidden="true">
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
                    <span className="scp-title">{title}</span>
                    <span className="scp-rule" />
                    {date && <span className="scp-date">{date}</span>}
                    {venue && <span className="scp-venue">{venue}</span>}
                    {extra && <span className="scp-extra">{extra}</span>}
                </span>
            )}
            <style jsx>{`
                .scp {
                    position: relative; display: block; width: 100%; aspect-ratio: 1200 / 630; container-type: inline-size;
                    overflow: hidden; border-radius: 12px; clip-path: inset(0 round 12px); background: #0B0E18; color: #FFFFFF;
                }
                .scp.sq { aspect-ratio: 1 / 1; }
                .scp.none { background: radial-gradient(circle 125cqw at 100% 0, #24306F 0, #121E5A 52.5cqw, #0A0F2E 125cqw); }
                .scp-photo { position: absolute; top: 0; right: 0; bottom: 0; left: 34%; overflow: hidden; }
                .scp.sq .scp-photo { left: 0; }
                .scp-shade {
                    position: absolute; top: 0; right: 0; bottom: 0; left: 0;
                    background: linear-gradient(90deg, rgba(11, 14, 24, 1) 0%, rgba(11, 14, 24, 1) 34%, rgba(11, 14, 24, 0.62) 46%, rgba(11, 14, 24, 0.14) 66%, rgba(11, 14, 24, 0) 80%);
                }
                .scp-ring {
                    position: absolute; left: 64cqw; top: 22.5cqw; width: 46cqw; height: 46cqw;
                    border: 2.17cqw solid #FF5B00; border-radius: 50%; box-sizing: border-box;
                }
                .scp.sq .scp-ring { left: 57.96cqw; top: 57.96cqw; width: 64.07cqw; height: 64.07cqw; border-width: 2.96cqw; }
                .scp-text {
                    position: absolute; left: 5cqw; top: 0; bottom: 0; width: 55cqw;
                    display: flex; flex-direction: column; justify-content: center; align-items: flex-start;
                }
                .scp.sq .scp-text { left: 7.96cqw; width: 83.3cqw; }
                .scp-top { display: flex; align-items: center; gap: 2cqw; margin-bottom: 2.83cqw; }
                .scp.sq .scp-top { margin-bottom: 5cqw; }
                .scp-logo { display: block; height: 5.17cqw; width: auto; max-width: none; }
                .scp.sq .scp-logo { height: 8.15cqw; }
                .scp-kind {
                    font: 700 1.58cqw/1 var(--font-sans); letter-spacing: 0.14em; text-transform: uppercase; white-space: nowrap;
                    padding: 0.83cqw 1.17cqw; border: 0.17cqw solid rgba(255, 255, 255, 0.72);
                }
                .scp-kind.prop { color: #FF5B00; border-color: #FF5B00; }
                .scp-title {
                    font: 400 7.42cqw/0.98 'DM Serif Display', Georgia, serif; max-width: 46.67cqw; overflow-wrap: anywhere;
                    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
                }
                .scp.sq .scp-title { font-size: 12.04cqw; max-width: 79.6cqw; -webkit-line-clamp: 3; }
                .scp-rule { display: block; width: 30cqw; height: 0.17cqw; margin: 2cqw 0; background: rgba(246, 206, 133, 0.75); }
                .scp.sq .scp-rule { width: 44cqw; height: 0.23cqw; margin: 3.43cqw 0; }
                .scp-date { font: 600 2.17cqw/1 var(--font-sans); letter-spacing: 0.14em; text-transform: uppercase; white-space: nowrap; }
                .scp.sq .scp-date { font-size: 3.33cqw; }
                .scp-venue {
                    font: 400 4.5cqw/1.05 'DM Serif Display', Georgia, serif; color: #F6CE85; margin-top: 1.17cqw;
                    max-width: 46.67cqw; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                }
                .scp.sq .scp-venue { font-size: 7.04cqw; margin-top: 1.85cqw; max-width: 79.6cqw; }
                .scp-extra {
                    font: 700 1.83cqw/1 var(--font-sans); letter-spacing: 0.12em; text-transform: uppercase; white-space: nowrap;
                    color: #FF5B00; margin-top: 1.67cqw;
                }
                .scp.sq .scp-extra { font-size: 2.78cqw; margin-top: 2.78cqw; }
            `}</style>
        </div>
    );
}
