import Zod, { z } from "zod";
import {
	messageFilterSchema,
	sendRequestSchema,
} from "../../handlers/messages/types";
import { logInfo, projPath } from "../..";
import { getOAuthTokenCPI } from "../cpi_auth";
import {
	MessageProcessingLogs,
	messageProcessingLogs,
} from "../../generated/MessageProcessingLogs";
import { DeSerializers, or } from "@sap-cloud-sdk/odata-v2";
import { and, Filter, FilterList } from "@sap-cloud-sdk/odata-common";
import moment, { Moment } from "moment";
import { getCurrentDestination } from "../api_destination";
import { createIflow } from "../iflow";
import { integrationContent } from "../../generated/IntegrationContent";
import { folderToZipBuffer } from "../../utils/zip";
import path from "path";

const { messageProcessingLogsApi, messageProcessingLogAttachmentsApi } =
	messageProcessingLogs();

const errStatus = ["RETRY", "FAILED", "ABANDONED", "ESCALATED", "DISCARDED"];

const { integrationDesigntimeArtifactsApi } = integrationContent();

export const getFilters = (
	filterProps: z.infer<typeof messageFilterSchema>
) => {
	const {
		INTEGRATION_ARTIFACT,
		STATUS,
		LOG_START,
		LOG_END,
		SENDER,
		RECEIVER,
		MESSAGE_GUID
	} = messageProcessingLogsApi.schema;

	const filterArr: (
		| Filter<MessageProcessingLogs, DeSerializers, Moment | null | string>
		| FilterList<MessageProcessingLogs, DeSerializers>
	)[] = [];

	if (filterProps.LogEnd) {
		const momentTime = moment(filterProps.LogEnd);
		const logEndFilter = LOG_END.lessOrEqual(momentTime);
		filterArr.push(logEndFilter);
	}
	if (filterProps.LogStart) {
		const momentTime = moment(filterProps.LogStart);
		const loStartFilter = LOG_START.greaterOrEqual(momentTime);
		filterArr.push(loStartFilter);
	}

	if (filterProps.integrationFlowId)
		filterArr.push(
			INTEGRATION_ARTIFACT.id.equals(filterProps.integrationFlowId)
		);
	if (filterProps.status) {
		const filterStatusArr: Filter<
			MessageProcessingLogs,
			DeSerializers,
			Moment | null | string
		>[] = [];
		filterProps.status.forEach((statusValue) =>
			filterStatusArr.push(STATUS.equals(statusValue))
		);
		const statusOrFilter = or(filterStatusArr);
		filterArr.push(statusOrFilter);
	}

	if (filterProps.sender) filterArr.push(SENDER.equals(filterProps.sender));
	if (filterProps.receiver)
		filterArr.push(RECEIVER.equals(filterProps.receiver));

	if (filterProps.msgGUID) filterArr.push(MESSAGE_GUID.equals(filterProps.msgGUID));

	return and(filterArr);
};

/**
 * Options controlling how much detail is loaded per message.
 * Each enabled "include" causes an extra API call per message (attachments
 * additionally download the base64 media), so they default to off to keep
 * responses small and fast. Error information is loaded by default because it
 * is the main reason to inspect failed messages.
 */
export interface GetMessagesOptions {
	/** Max messages to fetch (SAP cap is 50). */
	limit?: number;
	/** Fetch adapter attributes per message. */
	includeAdapterAttributes?: boolean;
	/** Fetch custom header properties per message. */
	includeCustomHeaders?: boolean;
	/** Fetch attachment metadata AND download the base64 attachment bodies. */
	includeAttachments?: boolean;
	/** Fetch error information for failed/retry/etc. messages (default true). */
	includeErrorInformation?: boolean;
}

/**
 * Get messages from messaging log with optional dependencies.
 * @param filterProps Available filters
 * @param options What extra detail to load and how many messages to return
 * @returns Messages, enriched only with the requested details
 */
export const getMessages = async (
	filterProps: z.infer<typeof messageFilterSchema>,
	options: GetMessagesOptions = {}
): Promise<
	(MessageProcessingLogs & {
		ErrorInformationValue?: string;
		messageAttachementFiles?: { description?: string; data: string }[];
	})[]
> => {
	const {
		limit = 50,
		includeAdapterAttributes = false,
		includeCustomHeaders = false,
		includeAttachments = false,
		includeErrorInformation = true,
	} = options;

	// SAP caps the result set at 50; keep within that and honor a smaller limit.
	const effectiveLimit = Math.min(Math.max(limit, 1), 50);

	const messageBaseReq = messageProcessingLogsApi
		.requestBuilder()
		.getAll()
		.top(effectiveLimit)
		.filter(getFilters(filterProps));

	logInfo(await messageBaseReq.url(await getCurrentDestination()));

	const messageWithErrVal: (MessageProcessingLogs & {
		ErrorInformationValue?: string;
		messageAttachementFiles?: { description?: string; data: string }[];
	})[] = await messageBaseReq.execute(await getCurrentDestination());

	logInfo(`Found ${messageWithErrVal.length} messages`);

	// Fill only the requested dependencies of the message log entry
	return Promise.all(
		messageWithErrVal.map(async (message) => {
			if (includeAdapterAttributes) {
				try {
					message.adapterAttributes = (
						await messageProcessingLogsApi
							.requestBuilder()
							.getByKey(message.messageGuid)
							.appendPath("/AdapterAttributes")
							.executeRaw(await getCurrentDestination())
					).data;
				} catch (error) {
					logInfo(
						`Could not get adapterAttributes for ${message.messageGuid}`
					);
				}
			}

			if (includeCustomHeaders) {
				try {
					message.customHeaderProperties = (
						await messageProcessingLogsApi
							.requestBuilder()
							.getByKey(message.messageGuid)
							.appendPath("/CustomHeaderProperties")
							.executeRaw(await getCurrentDestination())
					).data.d.results;
				} catch (error) {
					logInfo(
						`Could not get CustomHeaderProperties for ${message.messageGuid}`
					);
					logInfo(error);
				}
			}

			if (includeAttachments) {
				try {
					message.attachments = (
						await messageProcessingLogsApi
							.requestBuilder()
							.getByKey(message.messageGuid)
							.appendPath("/Attachments")
							.executeRaw(await getCurrentDestination())
					).data.d.results;

					logInfo(
						`Found ${message.attachments.length} attachements for ${message.messageGuid}`
					);

					message.messageAttachementFiles = [];

					for (const attachement of message.attachments) {
						message.messageAttachementFiles?.push({
							description: attachement.name as string,
							// TS ignore because SAP specification is not what they actually provide

							data: await getMessageMedia(
								// @ts-ignore
								attachement["Id"] as string
							),
						});
					}
				} catch (error) {
					logInfo(
						`Could not get Attachments for ${message.messageGuid}`
					);
					logInfo(
						await messageProcessingLogsApi
							.requestBuilder()
							.getByKey(message.messageGuid)
							.appendPath("/Attachments")
							.url(await getCurrentDestination())
					);
					logInfo(error);
				}
			}

			if (
				includeErrorInformation &&
				message.status &&
				errStatus.includes(message.status)
			) {
				try {
					logInfo(
						`Getting error value for msg: ${message.messageGuid}`
					);
					message.errorInformation = (
						await messageProcessingLogsApi
							.requestBuilder()
							.getByKey(message.messageGuid)
							.appendPath("/ErrorInformation")
							.executeRaw(await getCurrentDestination())
					).data.d.results;
					message.ErrorInformationValue = (
						await messageProcessingLogsApi
							.requestBuilder()
							.getByKey(message.messageGuid)
							.appendPath("/ErrorInformation/$value")
							.executeRaw(await getCurrentDestination())
					).data;
				} catch (error) {
					logInfo(
						`Error getting error info for ${message.messageGuid}`
					);
				}
			}

			return message;
		})
	);
};

/**
 * Count messages of given filter
 * @param filterProps
 */
export const getMessagesCount = async (
	filterProps: z.infer<typeof messageFilterSchema>
): Promise<number> => {
	return messageProcessingLogsApi
		.requestBuilder()
		.getAll()
		.filter(getFilters(filterProps))
		.count()
		.execute(await getCurrentDestination());
};

/**
 * Returns message media like attachement as string
 * @param mediaId
 * @returns Media as string
 */
export const getMessageMedia = async (mediaId: string): Promise<string> => {
	logInfo(`Getting file ${mediaId}`);

	return (
		await messageProcessingLogAttachmentsApi
			.requestBuilder()
			.getByKey(mediaId)
			.appendPath("/$value")
			.executeRaw(await getCurrentDestination())
	).data;
};

export const createMappingTestIflow = async (pkgId: string) => {
	try {
		await integrationDesigntimeArtifactsApi
			.requestBuilder()
			.delete("if_echo_mapping", "active")
			.execute(await getCurrentDestination());
	} catch (error) { }

	const iflowBuffer = await folderToZipBuffer(
		path.resolve(projPath, "resources", "helpers", "if_echo_mapping")
	);

	const newIflow = integrationDesigntimeArtifactsApi
		.entityBuilder()
		.fromJson({
			id: "if_echo_mapping",
			name: "if_echo_mapping",
			packageId: pkgId,
			artifactContent: iflowBuffer.toString("base64"),
		});

	await integrationDesigntimeArtifactsApi
		.requestBuilder()
		.create(newIflow)
		.execute(await getCurrentDestination());
};
