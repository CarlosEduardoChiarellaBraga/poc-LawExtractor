import { Injectable, BadRequestException } from '@nestjs/common';
import { convertLegalXmlToJson } from './xml-to-json';

@Injectable()
export class ConvertService {
  async convertXmlBuffer(buffer: Buffer) {
    if (!buffer || buffer.length === 0) {
      throw new BadRequestException('Empty file');
    }

    const xml = buffer.toString('utf-8');

    try {
      const units = convertLegalXmlToJson(xml);

      return {
        units,
        count: units.length,
        stats: this.buildStats(units),
      };
    } catch (err) {
      throw new BadRequestException(`XML processing failed: ${err}`);
    }
  }

  private buildStats(units: any[]) {
    return units.reduce<Record<string, number>>((acc, u) => {
      acc[u.type] = (acc[u.type] ?? 0) + 1;
      return acc;
    }, {});
  }
}