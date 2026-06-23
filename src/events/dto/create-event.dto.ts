import {
  IsEmail,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Incoming support-ticket event. `idempotencyKey` is optional: a client may
 * supply one (e.g. its own request id) or omit it, in which case the server
 * derives the key from a hash of the content (see EventsService).
 */
export class CreateEventDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  idempotencyKey?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  subject!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  body!: string;

  @IsOptional()
  @IsEmail()
  requesterEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  source?: string;

  /** Arbitrary client metadata; stored with the raw event, not interpreted. */
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
