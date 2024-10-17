import OpenAI from "openai";
import fs from "fs";
import { items } from "./items.js";
import chalk from "chalk";

const API_KEY = 'API_KEY';

const openai = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: API_KEY,
});

const localOpenai = new OpenAI({
    baseURL: "http://127.0.0.1:1234/v1",
    apiKey: "none"
})

function sampleNormalDistribution(mean, stdDev) {
    const u = 1 - Math.random();
    const v = Math.random();
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return z * stdDev + mean;
}

function roundToTwoDecimals(num) {
    return Math.round(num * 100) / 100;
}

function interactionToVendor(interaction, vendorPrompt) {
    const newInteraction = interaction.map(message => ({
        role: message.role === "vendor" ? "assistant" : "user",
        content: message.content
    }));
    newInteraction.unshift({ role: "user", content: "<beginNegotiation>" });
    newInteraction.unshift({ role: "system", content: vendorPrompt });
    return newInteraction;
}

function interactionToCustomer(interaction, customerPrompt) {
    const newInteraction = interaction.map(message => ({
        role: message.role === "vendor" ? "user" : "assistant",
        content: message.content
    }));
    newInteraction.unshift({ role: "system", content: customerPrompt });
    return newInteraction;
}

const vendorModel = "qwen/qwen-2.5-72b-instruct";
const customerModel = "llama-3.2-3b-customer-iter1-8bit";

async function queryRole(role, interaction, vendorPrompt, customerPrompt) {
    const i = role === "vendor" ? interactionToVendor(interaction, vendorPrompt) : interactionToCustomer(interaction, customerPrompt);
    const client = role === "vendor" ? openai : localOpenai;
    const model = role === "vendor" ? vendorModel : customerModel;

    const controller = new AbortController();
    const timeout = role === "vendor" ? 10000 : undefined; // 10 seconds timeout for remote calls

    try {
        const timeoutId = timeout ? setTimeout(() => controller.abort(), timeout) : null;

        const response = await client.chat.completions.create({
            model: model,
            messages: i,
            signal: controller.signal
        });

        if (timeoutId) clearTimeout(timeoutId);

        return response.choices[0].message.content;
    } catch (error) {
        if (error.name === "AbortError") {
            console.log("Request aborted due to timeout");
            throw new Error("API call timed out");
        }
        throw error;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runDeal(portNumber, dealsCompleted) {
    while (true) {
        try {
            const selectedItem = items[Math.floor(Math.random() * items.length)];
            let price = sampleNormalDistribution(selectedItem.price, selectedItem.std_dev);
            if (Math.random() < 0.5) {
                price = Math.round(price) - 0.01;
            } else {
                price = roundToTwoDecimals(price);
                if (price > 100) {
                    price = Math.round(price * 10) / 10;
                }
                if (price > 1000) {
                    price = Math.round(price);
                }
            }
            if (price < 0.01) {
                // Something has gone wrong, retry
                continue;
            }
            console.log(`[Port ${portNumber}] Deal started for ${selectedItem.item} at $${price}`);

            const vendorPrompt = `Assume the role of a market vendor selling a ${selectedItem.item} for $${price.toFixed(2)}. The user will try to talk you down. Your goal is to sell the ${selectedItem.item} at the fair, market price - $${price.toFixed(2)}. To make a deal, respond <deal>PRICE</deal> at the end of your message, where PRICE is what you decided to sell the ${selectedItem.item} for. You can only respond <deal> at a price that the customer has stated they are willing to buy. You cannot offer additional items to sweeten the deal, and cannot sell at a price higher than the one you initially intended to. The first message from the user will be a system directive that simply states <beginNegotiation> - to which you should immediately respond in character, as if you are the vendor greeting the customer. State the price of the ${selectedItem.item} in your opening line and be prepared to negotiate. You only have five messages each to make a deal.`;
            const customerPrompt = `Assume the role of a customer looking to buy a ${selectedItem.item}. Your goal is to negotiate the price down as much as possible, while still getting the vendor to agree to sell you the ${selectedItem.item}. Your goal is to buy the item for *as cheap as possible*. You only have five messages each to make a deal.`;

            const interaction = [];
            let role = "vendor";
            let priceSoldAt = -1;

            for (let i = 0; i < 10; i++) {
                try {
                    const response = await queryRole(role, interaction, vendorPrompt, customerPrompt);
                    interaction.push({ role: role, content: response });
                    if (response.includes("<deal>") && role === "vendor") {
                        const dealPrice = parseFloat(response.match(/<deal>(.*)<\/deal>/)[1]);
                        priceSoldAt = dealPrice;
                        break;
                    }
                    role = role === "vendor" ? "customer" : "vendor";
                } catch (error) {
                    if (error.message === "API call timed out") {
                        console.log(`[Port ${portNumber}] API call timed out. Waiting 10 seconds before retrying...`);
                        await sleep(10000);
                        continue;
                    }
                    throw error; // Re-throw other errors
                }
            }

            if (priceSoldAt === -1) {
                console.log(`[Port ${portNumber}] No deal was made for ${selectedItem.item}.`);
            } else {
                console.log(`[Port ${portNumber}] Deal completed for ${selectedItem.item}. Price sold at: $${priceSoldAt.toFixed(2)}, Initial price: $${price.toFixed(2)}, Market price: $${selectedItem.price}, Discount: ${((1 - priceSoldAt / price) * 100).toFixed(2)}%`);
                const customerPerspective = interactionToCustomer(interaction, customerPrompt);
                const vendorPerspective = interactionToVendor(interaction, vendorPrompt);

                const customerFilepath = 'interactions_customer_iter5.jsonl';
                const vendorFilepath = 'interactions_vendor_iter5.jsonl';
                const customerObject = { messages: customerPerspective, price: priceSoldAt, item: selectedItem.item, initialPrice: price, marketPrice: selectedItem.price };
                const vendorObject = { messages: vendorPerspective, price: priceSoldAt, item: selectedItem.item, initialPrice: price, marketPrice: selectedItem.price };

                fs.appendFileSync(customerFilepath, JSON.stringify(customerObject) + "\n");
                fs.appendFileSync(vendorFilepath, JSON.stringify(vendorObject) + "\n");

                dealsCompleted.increment();
            }
        } catch (error) {
            console.error(`[Port ${portNumber}] Error encountered: ${error.message}`);
            console.log(`[Port ${portNumber}] Waiting 10 seconds before retrying...`);
            await sleep(10000);
        }
    }
}

class DealsCounter {
    constructor() {
        this.count = 0;
    }

    increment() {
        this.count++;
    }

    reset() {
        const temp = this.count;
        this.count = 0;
        return temp;
    }
}

async function logDealsPerMinute(dealsCompleted) {
    while (true) {
        await sleep(60000); // Wait for 1 minute
        const deals = dealsCompleted.reset();
        console.log(chalk.green(`Deals per minute: ${deals}`));
    }
}

async function main() {
    const dealsCompleted = new DealsCounter();
    const ports = Array(5).fill().map((_, index) => runDeal(index + 1, dealsCompleted));
    ports.push(logDealsPerMinute(dealsCompleted));
    await Promise.all(ports);
}

main();