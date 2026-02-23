import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConvertService } from './convert.service';

@Controller('convert')
export class ConvertController {
  constructor(private readonly ragService: ConvertService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file'))
  async convertXml(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('XML file is required');
    }

    const result = await this.ragService.convertXmlBuffer(file.buffer);

    return {
      filename: file.originalname,
      ...result,
    };
  }
}