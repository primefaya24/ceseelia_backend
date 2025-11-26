import Stripe from "stripe";
import {
    getWebsiteInfo,
    wooUpdateOrderPaymentIntentSucceeded,
    wooUpdateOrderPaymentSessionCompleted, wooUpdateOrderRefundedCharge
} from "../../../../aws/dynamodb/dynamo-entities/website";
import {
    OrderOnlinePaymentIntentSucceeded, OrderOnlinePaymentRefundedCharge,
    OrderOnlinePaymentSessionCompleted
} from "../../../interfaces/stripe/indes";
import {kmsGetSecret} from "../../../../aws/secret-manager";
const stripeConfig = {
    apiVersion: "2025-08-27.basil" as const,
};

export async function wooHandleStripeEvent(req: any, res: any): Promise<void> {
    try {
        // Fetch sk & webhookSecret from secrets manager
        const websiteId: string = req.params.websiteId;
        getWebsiteInfo(websiteId)
            .then(
            (websiteInfo) => {
                if (websiteInfo) {
                    kmsGetSecret(websiteInfo.websiteSecretName)
                        .then((websiteSecretData) => {
                            if (websiteSecretData?.websiteStripeSk?.length > 0 && websiteSecretData?.websiteStripeWhsec?.length > 0) {
                                // Construct Stripe event
                                const sig: string = req.headers["stripe-signature"] as string;
                                const stripe: Stripe = new Stripe(websiteSecretData!.websiteStripeSk as string, stripeConfig);
                                const event: any = stripe.webhooks.constructEvent(req.body, sig, websiteSecretData!.websiteStripeWhsec);

                                // Handle Stripe event
                                switch (event.type) {
                                    case "checkout.session.completed": {
                                        // Construct Stripe session
                                        const session: any = event.data.object as Stripe.Checkout.Session;
                                        const sessionData: OrderOnlinePaymentSessionCompleted = {
                                            id: session.id,
                                            paymentIntentId: session.payment_intent,
                                            amountTotal: session.amount_total,
                                            currency: session.currency,
                                            paymentStatus: session.payment_status,
                                            metadata: session.metadata,
                                        };

                                        // Update order with session data
                                        wooUpdateOrderPaymentSessionCompleted(websiteId, sessionData).then();

                                        break;
                                    }
                                    case "payment_intent.succeeded": {
                                        // Construct Stripe intent
                                        const intent = event.data.object as Stripe.PaymentIntent;
                                        const intentData: OrderOnlinePaymentIntentSucceeded= {
                                            id: intent.id,
                                            status: intent.status,
                                            amount: intent.amount,
                                            currency: intent.currency,
                                            metadata: intent.metadata,
                                        };

                                        // Update order with intent data
                                        wooUpdateOrderPaymentIntentSucceeded(websiteId, intentData).then();

                                        break;
                                    }
                                    case "charge.refunded": {
                                        // Construct Stripe Refund
                                        const charge = event.data.object as Stripe.Charge;
                                        const refundData: OrderOnlinePaymentRefundedCharge = {
                                            id: charge.id,
                                            intentId: typeof charge.payment_intent === "string"
                                                ? charge.payment_intent as string
                                                : charge.payment_intent && typeof charge.payment_intent === "object"
                                                    ? (charge.payment_intent as Stripe.PaymentIntent).id as string
                                                    : "",
                                            amountRefunded: charge.amount_refunded,
                                        };

                                        // Update order with refund data
                                        wooUpdateOrderRefundedCharge(stripe, websiteId, refundData).then();

                                        break;
                                    }
                                }
                            }
                        })
                        .catch((err) => {
                            console.error("In dqs: wooHandleStripeEvent->kmsGetSecret", err);
                        });
                }
            })
            .catch((err) => {
            console.error("In dqs: wooHandleStripeEvent->getWebsiteInfo", err);
        });
        res.sendStatus(200);
    }
    catch (err: any) {
        console.error("In dqs: wooHandleStripeEvent", err);
        res.status(400).send(`Webhook Error: ${err.message}`);
    }
}



