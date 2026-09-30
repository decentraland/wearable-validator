/** The work queue a review job drains: one message at a time, deleted only once its result reached the Builder. */
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { IConfigComponent } from "@well-known-components/interfaces";

const LONG_POLL_SECONDS = 10;
// a review renders for a minute or more and calls the model: the 30 s default would hand it to a second task mid-flight
const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 1800;

export interface QueueMessage {
  id: string;
  receiptHandle: string;
  body: string;
}

export interface IWorkQueueComponent {
  /** One message, or undefined after a long poll that found none. */
  receive(): Promise<QueueMessage | undefined>;
  delete(receiptHandle: string): Promise<void>;
}

export async function createWorkQueueComponent(components: { config: IConfigComponent }): Promise<IWorkQueueComponent> {
  const { config } = components;
  const queueUrl = await config.requireString("WORK_QUEUE_URL");
  const visibilityTimeout = (await config.getNumber("VISIBILITY_TIMEOUT_SECONDS")) ?? DEFAULT_VISIBILITY_TIMEOUT_SECONDS;
  // region and credentials come from the task role; AWS_ENDPOINT_URL_SQS points it at a local queue for development
  const client = new SQSClient({});
  return {
    async receive() {
      const result = await client.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: LONG_POLL_SECONDS, VisibilityTimeout: visibilityTimeout }));
      const message = result.Messages?.[0];
      if (!message?.Body || !message.ReceiptHandle || !message.MessageId) return undefined;
      return { id: message.MessageId, receiptHandle: message.ReceiptHandle, body: message.Body };
    },
    async delete(receiptHandle) {
      await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
    }
  };
}
