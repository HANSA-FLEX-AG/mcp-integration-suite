import { z } from "zod";
import { McpServerWithMiddleware } from "../../utils/middleware";
import { logError, projPath } from "../..";
import fsAsync from 'fs/promises';
import fs from 'fs';
import path from "path";
import { glob, globSync } from "glob";
import { formatError } from "../../utils/customErrHandler";

const getDocsMap = () => {
    const baseDocPath = path.join(projPath, "resources", "Docs", "ISuite");
    const allFiles = globSync(path.join(baseDocPath, "**", "*.md").replace(/\\/g, '/'), { nodir: true });

    const resultObj: { [key: string]: string } = {};

    for (const file of allFiles) {
        const displayFile = path.relative(baseDocPath, file);
        resultObj[displayFile] = fs.readFileSync(file).toString("utf-8")
    }

    return resultObj;
}

const docsMap: { [key: string]: string } = getDocsMap();

export const registerDocsHandlers = (server: McpServerWithMiddleware) => {
    server.registerToolIntegrationSuite("get-docs",
        "Get indexed documentation parts. From the index of the SAP integration Suite documentation jump to any part of the documentation you want",
        {
            docPath: z.string().describe(`
Internal documentation path e.g. 40-RemoteSystems/basic-authentication-of-an-idp-user-for-api-clients-57f104d.md
If not provided it returns the index`).optional()
        }, async ({ docPath }) => {
            docPath = docPath ? docPath : "index.md";
            const fullDocPath = path.join(projPath, "resources", "Docs", "ISuite", docPath);

            const docStr = (await fsAsync.readFile(fullDocPath)).toString()
            const formattedString = JSON.stringify({
                docPath,
                text: docStr
            })

            return {
                content: [{
                    type: "text",
                    text: formattedString
                }]
            }
        })

    server.registerToolIntegrationSuite("search-docs", `Search for docs based on keywords.
By default this returns only the matching document paths plus a short snippet around the first match, so the response stays small. Use get-docs with a returned path to read the full document.
Set fullContent: true only when you really need the complete bodies inline.`, {
        keywords: z.array(z.string()).describe("Search keywords"),
        matchAll: z.boolean().describe("If true it must match all keywords, if false only one of the provided keywords"),
        fullContent: z.boolean().default(false).describe("Return the full document bodies instead of just paths + snippets. Can be very large."),
        limit: z.number().int().positive().default(20).describe("Maximum number of matching documents to return")
    }, async ({ keywords, matchAll, fullContent, limit }) => {
        try {
            const matchedPaths: string[] = [];

            Object.entries(docsMap).forEach(docPage => {
                const [key, value] = docPage;

                const matchedKeywords = (keywords as string[]).filter(
                    (keyword: string) => value.includes(keyword)
                );

                const isMatch = matchAll
                    ? matchedKeywords.length === keywords.length
                    : matchedKeywords.length > 0;

                if (isMatch) {
                    matchedPaths.push(key);
                }
            });

            const totalMatches = matchedPaths.length;
            const effectiveLimit = limit ?? 20;
            const pagedPaths = matchedPaths.slice(0, effectiveLimit);

            if (fullContent) {
                const docs: { [key: string]: string } = {};
                for (const key of pagedPaths) {
                    docs[key] = docsMap[key];
                }

                const result = JSON.stringify(docs);
                if (result.length > 1000000) {
                    throw new Error(`Your search returned documents with a total length of ${result.length}.
                    Please use different/more specific keywords or a smaller limit, or omit fullContent to get snippets instead. Total length must be < 1000000`);
                }

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            matches: docs,
                            totalMatches,
                            returned: pagedPaths.length,
                            truncated: totalMatches > pagedPaths.length
                        })
                    }]
                };
            }

            // Default: return paths + a snippet around the first keyword hit.
            const results = pagedPaths.map((key) => {
                const value = docsMap[key];
                const firstHit = (keywords as string[])
                    .map((keyword: string) => value.indexOf(keyword))
                    .filter((idx: number) => idx >= 0)
                    .sort((a: number, b: number) => a - b)[0] ?? 0;

                const start = Math.max(0, firstHit - 150);
                const snippet = value.slice(start, start + 400).trim();

                return {
                    docPath: key,
                    snippet: (start > 0 ? "…" : "") + snippet + "…",
                };
            });

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        results,
                        totalMatches,
                        returned: results.length,
                        truncated: totalMatches > results.length,
                        hint: "Use get-docs with a docPath to read the full document, or call again with fullContent: true."
                    })
                }]
            };
        } catch (error) {
            logError(error);
            return {
                isError: true,
                content: [formatError(error)],
            };
        }
    })
}