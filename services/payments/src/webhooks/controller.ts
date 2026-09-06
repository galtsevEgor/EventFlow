import {
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { ReceiveWebhook } from './receive';

@Controller('api/v1/webhooks')
export class WebhookController {
  constructor(@Inject(ReceiveWebhook) private readonly receive: ReceiveWebhook) {}
  @Post('stripe')
  @HttpCode(200)
  handle(
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ) {
    return this.receive.run(request.rawBody, signature);
  }
}
