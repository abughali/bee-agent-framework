import {
  AnySchemaLike,
  FromSchemaLike,
  createSchemaValidator,
  toJsonSchema,
} from "@/internals/helpers/schema.js";
import { GenerateOptions, LLMError } from "@/llms/base.js";
import { ChatLLM, ChatLLMOutput } from "@/llms/chat.js";
import { BaseMessage, Role } from "@/llms/primitives/message.js";
import { Retryable } from "@/internals/helpers/retryable.js";
import { PromptTemplate } from "@/template.js";
import { SchemaObject } from "ajv";
import { z } from "zod";

export interface GenerateSchemaInput<T> {
  maxRetries?: number;
  options?: T;
}

export abstract class BaseDriver<TGenerateOptions extends GenerateOptions = GenerateOptions> {
  protected abstract template: PromptTemplate.infer<{ schema: string }>;
  protected errorTemplate = new PromptTemplate({
    schema: z.object({
      errors: z.string(),
      expected: z.string(),
      received: z.string(),
    }),
    template: `Generated response does not match the expected schema!
Validation Errors: "{{errors}}"`,
  });

  constructor(protected llm: ChatLLM<ChatLLMOutput, TGenerateOptions>) {}

  protected abstract parseResponse(textResponse: string): unknown;
  protected abstract schemaToString(schema: SchemaObject): Promise<string> | string;
  protected guided(schema: SchemaObject): GenerateOptions["guided"] | undefined {
    return undefined;
  }

  async generate<T extends AnySchemaLike>(
    schema: T,
    input: BaseMessage[],
    { maxRetries = 3, options }: GenerateSchemaInput<TGenerateOptions> = {},
  ): Promise<FromSchemaLike<T>> {
    const jsonSchema = toJsonSchema(schema);
    const validator = createSchemaValidator(jsonSchema);
    const schemaString = await this.schemaToString(jsonSchema);

    const messages: BaseMessage[] = [
      BaseMessage.of({
        role: Role.SYSTEM,
        text: this.template.render({ schema: schemaString }),
      }),
      ...input,
    ];

    return new Retryable({
      executor: async () => {
        const rawResponse = await this.llm.generate(messages, {
          guided: this.guided(jsonSchema),
          ...options,
        } as TGenerateOptions);
        const textResponse = rawResponse.getTextContent();
        let parsedResponse: any;

        try {
          parsedResponse = this.parseResponse(textResponse);
        } catch (error) {
          throw new LLMError(`Failed to parse the generated response.`, [], {
            isFatal: false,
            isRetryable: true,
            context: { error: (error as Error).message, received: textResponse },
          });
        }

        const success = validator(parsedResponse);
        if (!success) {
          const context = {
            expected: schemaString,
            received: textResponse,
            errors: JSON.stringify(validator.errors ?? []),
          };

          messages.push(
            BaseMessage.of({
              role: Role.USER,
              text: this.errorTemplate.render(context),
            }),
          );
          throw new LLMError(
            "Failed to generate a structured response adhering to the provided schema.",
            [],
            {
              isFatal: false,
              isRetryable: true,
              context,
            },
          );
        }
        return parsedResponse as FromSchemaLike<T>;
      },
      config: {
        signal: options?.signal,
        maxRetries,
      },
    }).get();
  }
}
