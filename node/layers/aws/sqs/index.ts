// import { SQSClient, SendMessageBatchCommand, SendMessageBatchCommandInput } from "@aws-sdk/client-sqs";
// import {appConstants} from "../../../constants";
// import {STAGE} from "../../../config";
//
// // Initialize SQS client
// const sqsClient: SQSClient = new SQSClient({
//     region: appConstants.DEFAULT_REGION,
// });
//
// /**
//  * Push records to SQS in batches
//  * @param dataRecords - Array of data records to be pushed to the queue
//  */
// export async function pushToQueue(dataRecords: any[]): Promise<void> {
//     try {
//         for (let i = 0; i < dataRecords.length; i += appConstants.MAX_BATCH_SIZE) {
//             try {
//                 const batch = dataRecords.slice(i, i + appConstants.MAX_BATCH_SIZE);
//
//                 const entries: SendMessageBatchCommandInput["Entries"] = batch.map((entry, index) => ({
//                     Id: index.toString(),
//                     MessageBody: JSON.stringify(entry),
//                 }));
//
//                 const params: SendMessageBatchCommandInput = {
//                     QueueUrl: `https://sqs.us-east-1.amazonaws.com/258084617016/PrimeSyncQueue-${STAGE}`,
//                     Entries: entries,
//                 };
//
//                 await sqsClient.send(new SendMessageBatchCommand(params));
//             } catch (err) {
//                 console.error("Error processing batch in pushToQueue", err);
//             }
//         }
//     } catch (err) {
//         console.error("In pushToQueue", err);
//         throw err;
//     }
// }
