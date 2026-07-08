
import { promises as fs } from "fs";
import path from "path";
import { projPath } from "../..";
import { McpServerWithMiddleware } from "../../utils/middleware";
import { formatError } from "../../utils/customErrHandler";
import { filterList, listFilterParams } from "../../utils/responseFilter";

const resourceDiscoverPath = path.resolve(projPath, "./resources/Discover");

/** Compact fields for a discover-center package entry. */
const DISCOVER_DEFAULT_FIELDS = [
	"TechnicalName",
	"DisplayName",
	"ShortText",
	"Category",
	"Countries",
	"Products",
];

const DISCOVER_SEARCH_FIELDS = [
	"TechnicalName",
	"DisplayName",
	"ShortText",
	"Keywords",
	"Products",
	"Countries",
	"BusinessProcess",
];

/**
 * The full discover-center catalog is huge (hundreds of packages, ~400 KB) and
 * cannot be returned in one response. This tool now requires a search or a
 * limit so only a manageable slice is sent back.
 */
const DISCOVER_DEFAULT_LIMIT = 25;

export const registerPackageDiscoverHandler = (
	server: McpServerWithMiddleware
) => {
	server.registerToolIntegrationSuite(
		"discover-packages",
		`Get information about Packages from the discover center.
The full catalog is very large, so you MUST narrow it down: pass "search" to filter by name/keyword/product/country. Without a search only the first ${DISCOVER_DEFAULT_LIMIT} packages are returned.
Use "limit"/"offset" to page and "fields" (e.g. ["all"]) to control returned fields.`,
		{ ...listFilterParams },
		async ({ search, fields, limit, offset }) => {
			try {
				const raw = await fs.readFile(
					path.join(resourceDiscoverPath, "IntegrationPackages.json"),
					"utf-8"
				);
				const parsed = JSON.parse(raw);
				const allPackages: any[] = Array.isArray(parsed)
					? parsed
					: parsed?.d?.results ?? parsed?.results ?? [];

				const effectiveLimit =
					limit ?? (search ? undefined : DISCOVER_DEFAULT_LIMIT);

				const result = filterList(allPackages, {
					search,
					fields,
					limit: effectiveLimit,
					offset,
					searchFields: DISCOVER_SEARCH_FIELDS,
					defaultFields: DISCOVER_DEFAULT_FIELDS,
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								packages: result.items,
								returned: result.returned,
								matched: result.matched,
								total: result.total,
								truncated: result.truncated,
								hint: result.truncated
									? "More packages available. Refine 'search' or use 'offset' to page."
									: undefined,
							}),
						},
					],
				};
			} catch (error) {
				return {
					isError: true,
					content: [formatError(error)],
				};
			}
		}
	);
};
