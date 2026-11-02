import React, { useMemo } from 'react';
import { marked } from 'marked';
import { cleanDocumentHtml } from '../../utils/memberHtml';

marked.setOptions({ gfm: true, breaks: true });

/**
 * Renders sanitized markdown as HTML: a document (memberHtml.js), so its
 * pictures, tables and task lists stay. Follows the dangerouslySetInnerHTML
 * precedent from ArticleDetail.jsx, with equivalent typography so lesson text
 * reads like article text.
 */
const MarkdownView = ({ markdown, className }) => {
    const html = useMemo(
        () => cleanDocumentHtml(marked.parse(markdown || '')),
        [markdown]
    );

    return (
        <>
            <div
                className={'md-view ' + (className || '')}
                dangerouslySetInnerHTML={{ __html: html }}
            />
            <style jsx>{`
                .md-view {
                    font-size: 1.05rem;
                    line-height: 1.8;
                    color: var(--color-gray-700);
                    word-wrap: break-word;
                }
                .md-view p { margin: 0 0 1.25rem; }
                .md-view p:last-child { margin-bottom: 0; }
                .md-view h1 {
                    font-size: 1.75rem;
                    font-weight: 800;
                    line-height: 1.25;
                    margin: 2rem 0 1rem;
                    color: var(--color-gray-900);
                }
                .md-view h2 {
                    font-size: 1.5rem;
                    font-weight: 700;
                    margin: 2rem 0 1rem;
                    color: var(--color-gray-900);
                }
                .md-view h3 {
                    font-size: 1.25rem;
                    font-weight: 700;
                    margin: 1.5rem 0 0.75rem;
                    color: var(--color-gray-900);
                }
                .md-view h4,
                .md-view h5,
                .md-view h6 {
                    font-size: 1.05rem;
                    font-weight: 700;
                    margin: 1.25rem 0 0.6rem;
                    color: var(--color-gray-900);
                }
                .md-view h1:first-child,
                .md-view h2:first-child,
                .md-view h3:first-child { margin-top: 0; }
                .md-view a {
                    color: var(--color-primary);
                    text-decoration: underline;
                }
                .md-view strong { color: var(--color-gray-800); }
                .md-view ul,
                .md-view ol {
                    margin: 0 0 1.25rem;
                    padding-left: 1.5rem;
                }
                .md-view li { margin-bottom: 0.4rem; }
                .md-view li > ul,
                .md-view li > ol { margin: 0.4rem 0 0; }
                .md-view img {
                    max-width: 100%;
                    border-radius: 8px;
                    margin: 1.5rem 0;
                }
                .md-view blockquote {
                    border-left: 3px solid var(--color-primary);
                    padding-left: 1rem;
                    margin: 1.5rem 0;
                    color: var(--color-gray-500);
                    font-style: italic;
                }
                .md-view blockquote p { margin-bottom: 0.5rem; }
                .md-view code {
                    font-family: var(--font-mono);
                    font-size: 0.875em;
                    background: var(--color-gray-100);
                    color: var(--color-gray-800);
                    padding: 0.15em 0.4em;
                    border-radius: 4px;
                }
                .md-view pre {
                    background: var(--color-gray-100);
                    border: 1px solid var(--color-gray-200);
                    border-radius: 8px;
                    padding: 1rem 1.25rem;
                    margin: 1.5rem 0;
                    overflow-x: auto;
                    line-height: 1.6;
                }
                .md-view pre code {
                    background: none;
                    padding: 0;
                    border-radius: 0;
                    font-size: 0.875rem;
                }
                .md-view hr {
                    border: none;
                    border-top: 1px solid var(--color-gray-200);
                    margin: 2rem 0;
                }
                .md-view table {
                    width: 100%;
                    border-collapse: collapse;
                    margin: 1.5rem 0;
                    font-size: 0.95rem;
                    display: block;
                    overflow-x: auto;
                }
                .md-view th,
                .md-view td {
                    border: 1px solid var(--color-gray-200);
                    padding: 0.5rem 0.75rem;
                    text-align: left;
                }
                .md-view th {
                    background: var(--color-gray-100);
                    color: var(--color-gray-800);
                    font-weight: 700;
                }
            `}</style>
        </>
    );
};

export default MarkdownView;
