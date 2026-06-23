import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TicketEntity } from './entities/ticket.entity';

@Injectable()
export class TicketsService {
  constructor(
    @InjectRepository(TicketEntity)
    private readonly repo: Repository<TicketEntity>,
  ) {}

  async findByIdOrThrow(id: string): Promise<TicketEntity> {
    const ticket = await this.repo.findOne({ where: { id } });
    if (!ticket) {
      throw new NotFoundException(`ticket ${id} not found`);
    }
    return ticket;
  }
}
