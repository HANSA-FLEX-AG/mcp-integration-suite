import { z } from "zod";
import { messageFilterSchema, sendRequestSchema } from "./types";
import { getMessages, getMessagesCount } from "../../api/messages/messageLogs";
import { McpServerWithMiddleware } from "../../utils/middleware";
import { formatError } from "../../utils/customErrHandler";
import { sendRequestToCPI } from "../../api/messages/sendMessageToCPI";
import { pickFields, stripODataNoise } from "../../utils/responseFilter";

export const registerMessageHandlers = (server: McpServerWithMiddleware) => {
	server.registerToolIntegrationSuite(
		"send-http-message",
		`
send an HTTP request to integration suite.
If you need to get HTTP Endpoints please use get-iflow-endpoints
Please only provide HTTP Path without endpoint etc if the URL is https://abc123.itcpi01-rt-cfapps.aa11.hana.ondemand.com/http/myendpoint You should send /http/myendpoint

The URI path will allways be prefixed with protocol

This tool can be used to test mappings together with the endpoint of iflow if_echo_mapping by updating iflow with corresponding mapping
If you get a error response you can use get-messages functionality to find out more about the error
If not specified otherwise the user probably wants to see the text in response

Currently only non CSRF-protected endpoints are supported for POST requests, which could be a reason for 403 or 401
        `,
		sendRequestSchema,
		async ({ path, method, contentType, body, headers }) => {
			try {
				const requestResult = await sendRequestToCPI(
					path,
					method,
					contentType,
					body,
					headers
				);

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(requestResult),
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
		"get-messages",
		`
Get messages from the message monitoring.
By default this returns lightweight message metadata (including error information for failed messages) with OData noise stripped, to keep the response small.
Heavy details are OPT-IN because each one adds an API call per message and can be very large:
- includeAttachments: downloads the (base64) attachment bodies — usually huge, only enable when you actually need attachment content
- includeCustomHeaders / includeAdapterAttributes: extra per-message metadata
Use "limit" (max 50) to fetch fewer messages, and "fields" to restrict which top-level fields are returned.
For bigger queries which don't need message content consider using count-messages.
		`,
		{
			filterProps: messageFilterSchema,
			limit: z
				.number()
				.int()
				.positive()
				.max(50)
				.optional()
				.describe("Max number of messages to return (1-50, default 50)"),
			includeAttachments: z
				.boolean()
				.default(false)
				.describe(
					"Download attachment bodies (base64). Very large - keep false unless you need the content."
				),
			includeCustomHeaders: z
				.boolean()
				.default(false)
				.describe("Include custom header properties per message."),
			includeAdapterAttributes: z
				.boolean()
				.default(false)
				.describe("Include adapter attributes per message."),
			includeErrorInformation: z
				.boolean()
				.default(true)
				.describe(
					"Include error information for failed/retry/abandoned/etc. messages."
				),
			fields: z
				.array(z.string())
				.optional()
				.describe(
					'Return only these top-level fields per message. Use ["all"] for the full objects. Defaults to all fields of the (already trimmed) message.'
				),
		},
		async ({
			filterProps,
			limit,
			includeAttachments,
			includeCustomHeaders,
			includeAdapterAttributes,
			includeErrorInformation,
			fields,
		}) => {
			try {
				const messages = await getMessages(filterProps, {
					limit,
					includeAttachments,
					includeCustomHeaders,
					includeAdapterAttributes,
					includeErrorInformation,
				});

				const shaped = messages.map((message) =>
					pickFields(stripODataNoise(message), fields)
				);

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								messages: shaped,
								returned: shaped.length,
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
		"count-messages",
		`Count messages from the message monitoring
This function can be usefull for making evaluations by counting messages with specific filters`,
		{
			filterProps: messageFilterSchema,
		},
		async ({ filterProps }) => {
			try {
				const msgCount = await getMessagesCount(filterProps);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: `Found ${msgCount} messages with filter criteria`,
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
