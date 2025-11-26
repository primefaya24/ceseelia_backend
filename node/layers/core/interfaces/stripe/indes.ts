
export interface OrderOnlinePaymentSessionCompleted {
    id: string;
    paymentIntentId: string;
    amountTotal: number;
    currency: string;
    paymentStatus: string;
    metadata: {
        orderId: string;
    };
}

export interface OrderOnlinePaymentIntentSucceeded {
    id: string;
    status: string;
    amount: number;
    currency: string;
    metadata: any;
}

export interface OrderOnlinePaymentRefundedCharge {
    id: string;
    intentId: string;
    amountRefunded: number;
}

export interface OrderOnlinePaymentHandledPerson {
    id: string;
    amount: number;
}