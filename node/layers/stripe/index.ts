import Stripe from "stripe";
import {IN_DEV} from "../../config";
import {kmsGetSecret} from "../aws/secret-manager";
import {appConstants} from "../../constants";
import {getWebsiteInfo, wooGetOrderPaymentIntents} from "../aws/dynamodb/dynamo-entities/website";

const stripeConfig = {
    apiVersion: "2025-08-27.basil" as const,
};

export async function generateStripeCheckoutLink(websiteId: string, websiteSecretName: string, orderId: string, orderCode: string, amount: number, currency: string): Promise<string | null | undefined> {
    try {
        // Pull Stripe sk based belonging websiteId
        const websiteSecretData: Record<string, any> | null = await kmsGetSecret(websiteSecretName);
        if (websiteSecretData?.websiteStripeSk?.length > 0) {
            const stripe = new Stripe(websiteSecretData!.websiteStripeSk, stripeConfig);
            const session = await stripe.checkout.sessions.create({
                mode: "payment",
                payment_method_types: ["card"],

                // You can pass any custom amount from the backend
                line_items: [
                    {
                        price_data: {
                            currency: currency || "usd",
                            product_data: {
                                name: "Custom Payment",
                            },
                            unit_amount: amount, // e.g. 500 for $5.00
                        },
                        quantity: 1,
                    },
                ],

                // Redirect after success/cancel
                success_url: (IN_DEV ? "http://localhost:4200/order-submitted?" : "https://order.dinersxpress.com/order-submitted?") + `websiteId=${websiteId}&orderId=${orderId}&orderCode=${orderCode}`,
                cancel_url: (IN_DEV ? "http://localhost:4200/cart" : "https://order.dinersxpress.com/cart"),

                metadata: {
                    orderId
                },
                payment_intent_data: {
                    metadata: {
                        orderId
                    },
                },
            });

            return session.url;
        } else {
            throw appConstants.STRIPE_SK_NOT_EXISTS;
        }
    } catch (err) {
        console.error(err);
        throw err;
    }
}

export async function refundOrderAmount(
    websiteId: string,
    orderId: string,
    amount: number | null | undefined
): Promise<{ totalRefunded: number; refunds: Stripe.Refund[] }> {
    const IS_SIMULATION_MODE: boolean = false;
    try {
        // Fetch Website KMS Secret Name
        const websiteInfo: any = await getWebsiteInfo(websiteId);
        const websiteSecretName: string = websiteInfo.websiteSecretName ?? "";
        if (websiteSecretName.length === 0) {
            return { totalRefunded: 0, refunds: [] };
        }

        // Pull Stripe sk based belonging websiteId
        const websiteSecretData: Record<string, any> | null = await kmsGetSecret(websiteSecretName);
        const websiteStripeSk: string = websiteSecretData?.websiteStripeSk ?? "";
        if (websiteStripeSk.length === 0) {
            return { totalRefunded: 0, refunds: [] };
        }

        // Pull Order Payment Intent Ids
        const orderPaymentIntentsIds: string[] = await wooGetOrderPaymentIntents(
            websiteId,
            orderId,
            true
        ) as string[];
        if (IS_SIMULATION_MODE) {
            console.warn(
                `orderPaymentIntentsIds`, orderPaymentIntentsIds
            );
        }
        if (orderPaymentIntentsIds.length === 0) {
            return { totalRefunded: 0, refunds: [] };
        }

        // Build Stripe Object
        const stripe = new Stripe(websiteStripeSk, stripeConfig);

        // Fetch PaymentIntents in parallel, expanding latest_charge
        const paymentIntents = await Promise.all(
            orderPaymentIntentsIds.map(piId =>
                stripe.paymentIntents.retrieve(piId, { expand: ["latest_charge"] })
            )
        );

        // Collect refundable balances (using latest_charge)
        const refundableBuckets: { paymentIntentId: string; refundableRemaining: number }[] = [];
        for (const pi of paymentIntents) {
            const latestCharge = pi.latest_charge as Stripe.Charge | null;
            if (!latestCharge) {
                console.warn(`No latest_charge found for PaymentIntent ${pi.id}`);
                continue;
            }

            const refundableRemaining = latestCharge.amount - latestCharge.amount_refunded;
            if (IS_SIMULATION_MODE) {
                console.warn(
                    `PaymentIntent ${pi.id} → charge ${latestCharge.id} → refundableRemaining = ${refundableRemaining}`
                );
            }

            if (refundableRemaining > 0) {
                refundableBuckets.push({
                    paymentIntentId: pi.id,
                    refundableRemaining
                });
            }
        }

        // If no refundable amount is found, nothing to do
        if (refundableBuckets.length === 0) {
            if (IS_SIMULATION_MODE) {
                console.warn("No refundable balances found for order", orderId);
            }
            return { totalRefunded: 0, refunds: [] };
        }

        // Calculate total refundable across all payment intents
        const totalRefundable = refundableBuckets.reduce((acc, cur) => acc + cur.refundableRemaining, 0);
        if (IS_SIMULATION_MODE) {
            console.warn(`Total refundable across order ${orderId}: ${totalRefundable}`);
        }

        const refunds: Stripe.Refund[] = [];
        let totalRefunded = 0;

        if (amount == null) {
            if (IS_SIMULATION_MODE) {
                console.warn(`Refunding FULL order ${orderId} (all remaining balances)`);
            }
            for (const bucket of refundableBuckets) {
                if (bucket.refundableRemaining > 0) {
                    if (IS_SIMULATION_MODE) {
                        console.warn(
                            `Would refund ${bucket.refundableRemaining} from PaymentIntent ${bucket.paymentIntentId}`
                        );
                    } else {
                        const refund = await stripe.refunds.create(
                            {
                                payment_intent: bucket.paymentIntentId,
                                amount: bucket.refundableRemaining,
                                metadata: {
                                    orderId,
                                    websiteId,
                                },
                            },
                            {
                                idempotencyKey: `refund_${orderId}_${bucket.paymentIntentId}_${bucket.refundableRemaining}`,
                            }
                        );
                        refunds.push(refund);
                        totalRefunded += bucket.refundableRemaining;
                    }
                }
            }
        } else {
            if (amount > totalRefundable) {
                throw new Error(
                    `Refund amount ${amount} exceeds total refundable balance ${totalRefundable}`
                );
            }

            if (IS_SIMULATION_MODE) {
                console.warn(`Refunding PARTIAL amount ${amount} for order ${orderId}`);
            }
            let remaining: number = amount;
            for (const bucket of refundableBuckets) {
                if (remaining <= 0) break;

                const toRefund: number = Math.min(remaining, bucket.refundableRemaining);
                if (IS_SIMULATION_MODE) {
                    console.warn(
                        `Would refund ${toRefund} from PaymentIntent ${bucket.paymentIntentId} (remaining to refund after this = ${remaining - toRefund})`
                    );
                } else {
                    const refund = await stripe.refunds.create(
                        {
                            payment_intent: bucket.paymentIntentId,
                            amount: toRefund,
                            metadata: {
                                orderId,
                                websiteId,
                            },
                        },
                        {
                            idempotencyKey: `refund_${orderId}_${bucket.paymentIntentId}_${toRefund}`,
                        }
                    );

                    refunds.push(refund);
                    totalRefunded += toRefund;
                    remaining -= toRefund;
                }
            }
        }

        if (IS_SIMULATION_MODE) {
            console.warn(`Refund simulation complete for order ${orderId}`);
        }
        return { totalRefunded, refunds };
    } catch (e) {
        console.error("In wooRefundOrder", e);
        throw "Could not wooRefundOrder";
    }
}
