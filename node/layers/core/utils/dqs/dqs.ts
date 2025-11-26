export class EfficientQueue<T> {
    private inbox: T[] = [];
    private outbox: T[] = [];

    enqueue(item: T) {
        this.inbox.push(item);
    }

    dequeue(): T | undefined {
        if (this.outbox.length === 0) {
            while (this.inbox.length > 0) {
                this.outbox.push(this.inbox.pop()!);
            }
        }
        return this.outbox.pop();
    }

    peek(): T | undefined {
        if (this.outbox.length === 0) {
            while (this.inbox.length > 0) {
                this.outbox.push(this.inbox.pop()!);
            }
        }
        return this.outbox[this.outbox.length - 1];
    }

    isEmpty(): boolean {
        return this.inbox.length === 0 && this.outbox.length === 0;
    }

    size(): number {
        return this.inbox.length + this.outbox.length;
    }
}

export type QueueItem = {
    topicId: string;
    data: any;
};

export class DQS {
    private queue: EfficientQueue<QueueItem> = new EfficientQueue<QueueItem>();
    private isProcessing: boolean = false;

    constructor(private handler: (item: QueueItem) => Promise<void>) {}

    enqueue(item: QueueItem): void {
        this.queue.enqueue(item);
        this.processQueue();
    }

    private async processQueue(): Promise<void> {
        if (this.isProcessing) return;
        this.isProcessing = true;

        while (!this.queue.isEmpty()) {
            const item: QueueItem = this.queue.dequeue()!;
            try {
                await this.handler(item);
            } catch (error) {
                console.error(`❌ Error processing topic "${item.topicId}":`, error);
            }
        }

        this.isProcessing = false;
    }

    isBusy(): boolean {
        return this.isProcessing;
    }

    getQueueSize(): number {
        return this.queue.size();
    }
}