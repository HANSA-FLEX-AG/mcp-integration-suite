import { z } from "zod";

/**
 * Utilities for shrinking tool responses.
 *
 * The SAP OData APIs return a lot of payload that is useless to an LLM:
 *  - `__metadata` blocks and `__deferred` navigation links (long absolute URLs)
 *  - fields that are `null` / empty string / empty array
 *
 * On top of that, list endpoints can return hundreds of entries. These helpers
 * let every list tool strip the noise and expose `search` / `fields` / `limit`
 * filters so the model only pays for the data it actually needs.
 */

/** Object keys that are pure OData plumbing and never useful to the model. */
const ODATA_NOISE_KEYS = new Set(["__metadata", "__deferred"]);

/**
 * Recursively remove OData noise and prune empty values from a value.
 *
 *  - drops `__metadata` / `__deferred` keys
 *  - drops navigation properties shaped like `{ "__deferred": { uri } }`
 *  - drops `null`, `undefined`, `""`, empty arrays and empty objects
 *
 * Primitives are returned unchanged.
 */
export const stripODataNoise = (value: unknown): any => {
	if (Array.isArray(value)) {
		return value.map(stripODataNoise);
	}

	if (value !== null && typeof value === "object") {
		const result: Record<string, any> = {};

		for (const [key, raw] of Object.entries(value)) {
			if (ODATA_NOISE_KEYS.has(key)) {
				continue;
			}

			// Unresolved navigation property, e.g. { "__deferred": { "uri": ... } }
			if (
				raw !== null &&
				typeof raw === "object" &&
				!Array.isArray(raw) &&
				"__deferred" in (raw as Record<string, unknown>)
			) {
				continue;
			}

			const cleaned = stripODataNoise(raw);

			if (cleaned === null || cleaned === undefined || cleaned === "") {
				continue;
			}
			if (Array.isArray(cleaned) && cleaned.length === 0) {
				continue;
			}
			if (
				cleaned !== null &&
				typeof cleaned === "object" &&
				!Array.isArray(cleaned) &&
				Object.keys(cleaned).length === 0
			) {
				continue;
			}

			result[key] = cleaned;
		}

		return result;
	}

	return value;
};

/** Sentinel values in `fields` that mean "return everything". */
const ALL_FIELDS = new Set(["all", "*"]);

/**
 * Project an object down to the requested `fields`.
 * Returns the object unchanged when no fields are given or when `all`/`*`
 * is requested.
 */
export const pickFields = <T extends Record<string, any>>(
	obj: T,
	fields?: string[]
): Partial<T> => {
	if (!fields || fields.length === 0) {
		return obj;
	}
	if (fields.some((f) => ALL_FIELDS.has(f.toLowerCase()))) {
		return obj;
	}

	const result: Partial<T> = {};
	for (const field of fields) {
		if (field in obj) {
			result[field as keyof T] = obj[field];
		}
	}
	return result;
};

/**
 * Case-insensitive substring match against an object.
 * When `searchFields` is given only those fields are considered, otherwise all
 * string values (including nested ones) are searched.
 */
export const matchesSearch = (
	obj: Record<string, any>,
	term?: string,
	searchFields?: string[]
): boolean => {
	if (!term) {
		return true;
	}

	const needle = term.toLowerCase();

	if (searchFields && searchFields.length > 0) {
		return searchFields.some((field) => {
			const val = obj[field];
			return (
				typeof val === "string" && val.toLowerCase().includes(needle)
			);
		});
	}

	// Fall back to searching the serialized object so nested strings are covered.
	return JSON.stringify(obj).toLowerCase().includes(needle);
};

export interface ListFilterOptions {
	/** Case-insensitive substring filter. */
	search?: string;
	/** Fields to keep per item. `["all"]` keeps everything. */
	fields?: string[];
	/** Max items to return after filtering. */
	limit?: number;
	/** Items to skip (paging). */
	offset?: number;
	/** Fields to restrict `search` to. */
	searchFields?: string[];
	/** Fields returned when the caller does not specify `fields`. */
	defaultFields?: string[];
}

export interface FilteredList<T = any> {
	items: Partial<T>[];
	/** Number of items in this response. */
	returned: number;
	/** Number of items matching the filter before paging. */
	matched: number;
	/** Total number of items before filtering. */
	total: number;
	/** True when items were omitted by the limit/offset. */
	truncated: boolean;
}

/**
 * Apply the full noise-strip -> search -> page -> project pipeline to a list.
 * Returns a compact envelope with the items plus counts so the model can tell
 * whether it needs to page further or refine its filter.
 */
export const filterList = <T extends Record<string, any>>(
	items: T[],
	opts: ListFilterOptions = {}
): FilteredList<T> => {
	const total = items.length;

	let result = items.map((item) => stripODataNoise(item) as T);

	if (opts.search) {
		result = result.filter((item) =>
			matchesSearch(item, opts.search, opts.searchFields)
		);
	}

	const matched = result.length;
	const offset = opts.offset ?? 0;
	const paged =
		opts.limit != null
			? result.slice(offset, offset + opts.limit)
			: result.slice(offset);

	const fields =
		opts.fields && opts.fields.length > 0
			? opts.fields
			: opts.defaultFields;
	const projected = paged.map((item) => pickFields(item, fields));

	return {
		items: projected,
		returned: projected.length,
		matched,
		total,
		truncated: offset + paged.length < matched,
	};
};

/**
 * Shared zod parameters for list tools. Spread into a tool's input schema:
 *   { ...listFilterParams, someOtherParam: z.string() }
 */
export const listFilterParams = {
	search: z
		.string()
		.optional()
		.describe(
			"Case-insensitive substring filter. Only items containing this text are returned. Use this to narrow large lists instead of fetching everything."
		),
	fields: z
		.array(z.string())
		.optional()
		.describe(
			'Return only these fields for each item to keep the response small. Use ["all"] to get the full unfiltered objects. Defaults to a compact set of the most useful fields.'
		),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Maximum number of items to return after filtering."),
	offset: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe("Number of matching items to skip, for paging through results."),
};
