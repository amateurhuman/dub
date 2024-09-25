import z from "@/lib/zod";
import { clickEventSchema, clickEventSchemaTB } from "./clicks";
import { customerSchema } from "./customers";
import { commonDeprecatedEventFields } from "./deprecated";
import { linkEventSchema } from "./links";

export const trackSaleRequestSchema = z.object({
  // Required
  customerId: z
    .string({ required_error: "customerId is required" })
    .trim()
    .min(1, "customerId is required")
    .max(100)
    .describe(
      "This is the unique identifier for the customer in the client's app. This is used to track the customer's journey.",
    ),
  amount: z
    .number({ required_error: "amount is required" })
    .int()
    .positive()
    .describe("The amount of the sale. Should be passed in cents."),
  paymentProcessor: z
    .enum(["stripe", "shopify", "paddle"])
    .describe("The payment processor via which the sale was made."),

  // Optional
  eventName: z
    .string()
    .max(50)
    .optional()
    .default("Purchase")
    .describe(
      "The name of the sale event. It can be used to track different types of event for example 'Purchase', 'Upgrade', 'Payment', etc.",
    )
    .openapi({ example: "Purchase" }),
  invoiceId: z
    .string()
    .nullish()
    .default(null)
    .describe("The invoice ID of the sale."),
  currency: z
    .string()
    .default("usd")
    .describe("The currency of the sale. Accepts ISO 4217 currency codes."),
  metadata: z
    .record(z.unknown())
    .nullish()
    .default(null)
    .describe("Additional metadata to be stored with the sale event."),
});

export const trackSaleResponseSchema = z.object({
  eventName: z.string(),
  customer: z.object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    avatar: z.string().nullable(),
  }),
  sale: z.object({
    amount: z.number(),
    currency: z.string(),
    paymentProcessor: z.string(),
    invoiceId: z.string().nullable(),
    metadata: z.record(z.unknown()).nullable(),
  }),
});

export const saleEventSchemaTB = clickEventSchemaTB
  .omit({ timestamp: true })
  .and(
    z.object({
      timestamp: z.string().optional(), //autogenerated by Tinybird
      event_id: z.string(),
      event_name: z.string().default("Purchase"),
      customer_id: z.string(),
      payment_processor: z.string(),
      amount: z.number(),
      invoice_id: z.string().default(""),
      currency: z.string().default("usd"),
      metadata: z.string().default(""),
    }),
  );

// response from tinybird endpoint
export const saleEventSchemaTBEndpoint = z.object({
  event: z.literal("sale"),
  timestamp: z.string(),
  event_id: z.string(),
  event_name: z.string(),
  customer_id: z.string(),
  payment_processor: z.string(),
  invoice_id: z.string(),
  saleAmount: z.number(),
  click_id: z.string(),
  link_id: z.string(),
  url: z.string(),
  continent: z.string().nullable(),
  country: z.string().nullable(),
  city: z.string().nullable(),
  device: z.string().nullable(),
  browser: z.string().nullable(),
  os: z.string().nullable(),
  referer: z.string().nullable(),
  referer_url: z.string().nullable(),
  referer_url_processed: z.string().nullable(),
  qr: z.number().nullable(),
  ip: z.string().nullable(),
});

// response from dub api
export const saleEventResponseSchema = z
  .object({
    event: z.literal("sale"),
    timestamp: z.coerce.string(),
    eventId: z.string(),
    eventName: z.string(),
    // nested objects
    link: linkEventSchema,
    click: clickEventSchema,
    customer: customerSchema,
    sale: trackSaleRequestSchema.pick({
      amount: true,
      invoiceId: true,
      paymentProcessor: true,
    }),
    saleAmount: z
      .number()
      .describe("Deprecated. Use `sale.amount` instead.")
      .openapi({ deprecated: true }),
    invoice_id: z
      .string()
      .describe("Deprecated. Use `sale.invoiceId` instead.")
      .openapi({ deprecated: true }),
    payment_processor: z
      .string()
      .describe("Deprecated. Use `sale.paymentProcessor` instead."),
  })
  .merge(commonDeprecatedEventFields)
  .openapi({ ref: "SaleEvent" });
