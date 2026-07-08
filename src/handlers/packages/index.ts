import { z } from "zod";
import { createPackage, getPackage, getPackages } from "../../api/packages";
import { McpServerWithMiddleware } from "../../utils/middleware";
import { formatError } from "../../utils/customErrHandler";
import { filterList, listFilterParams, stripODataNoise } from "../../utils/responseFilter";

/** Compact set of package fields that are actually useful to the model. */
const PACKAGE_DEFAULT_FIELDS = [
	"id",
	"name",
	"shortText",
	"vendor",
	"version",
	"mode",
	"supportedPlatform",
	"modifiedBy",
	"modifiedDate",
];

const PACKAGE_SEARCH_FIELDS = [
	"id",
	"name",
	"shortText",
	"description",
	"keywords",
	"vendor",
];

export const registerPackageHandlers = (server: McpServerWithMiddleware) => {
	server.registerToolIntegrationSuite(
		"packages",
		`Get all integration packages.
By default only a compact set of fields is returned per package and OData metadata/navigation noise is stripped to keep the response small.
Use "search" to filter by name/id/description, "limit"/"offset" to page, and "fields" (e.g. ["all"]) to control which fields are returned.`,
		{ ...listFilterParams },
		async ({ search, fields, limit, offset }) => {
			try {
				const allPackages = await getPackages();
				const result = filterList(allPackages as any[], {
					search,
					fields,
					limit,
					offset,
					searchFields: PACKAGE_SEARCH_FIELDS,
					defaultFields: PACKAGE_DEFAULT_FIELDS,
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

	server.registerToolIntegrationSuite(
		"package",
		"Get Content of a integration package by name",
		{
			name: z.string().describe("Name/ID of the package"),
		},
		async ({ name }) => {
			try {
				const packageContent = await getPackage(name);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(stripODataNoise(packageContent)),
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

	server.registerToolIntegrationSuite(
		"create-package",
		"Create a new integration package",
		{
			id: z.string().describe("ID of the package"),
			name: z
				.string()
				.optional()
				.describe("Package Name (uses ID by default)"),
			shortText: z
				.string()
				.optional()
				.describe("Short text of the package"),
		},
		async ({ id, name, shortText }) => {
			try {
				const packageContent = await createPackage(id, name, shortText);
				return {
					content: [
						{ type: "text", text: JSON.stringify(packageContent) },
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
