import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { MenuItemAvailability } from '@prisma/client';
import { Request } from 'express';
import { toActor } from '../../../common/auth/actor';
import { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { JwtAuthGuard, MerchantScopeGuard } from '../../../common/auth/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { MenuService } from '../application/menu.service';
import {
  CreateMenuCategoryDto,
  CreateMenuItemDto,
  ReorderMenuDto,
  SetItemAvailabilityDto,
  UpdateMenuCategoryDto,
  UpdateMenuItemDto,
} from './dto/menu.dto';
import { MenuCategoryView, MenuItemView, OwnerMenuView } from './merchant.views';

/**
 * Menu CRUD for the owning merchant.
 *
 * Every route is scoped by `:merchantId` and passes through `MerchantScopeGuard`
 * *and* re-checks ownership in the query (`where: { id, merchantId }`). The
 * guard alone would be enough for authorisation, but the redundant filter means
 * a future route added without the guard still cannot read another shop's menu.
 */
@Controller('merchant/:merchantId/menu')
@UseGuards(JwtAuthGuard, MerchantScopeGuard)
export class MenuController {
  constructor(private readonly menu: MenuService) {}

  // --------------------------------------------------------------------------
  //  Read
  // --------------------------------------------------------------------------

  /** The whole menu, including HIDDEN items — this is the editor's payload. */
  @Get()
  list(@Param('merchantId', new ParseUUIDPipe()) merchantId: string): Promise<OwnerMenuView> {
    return this.menu.listOwn(merchantId);
  }

  // --------------------------------------------------------------------------
  //  Categories
  // --------------------------------------------------------------------------

  @Post('categories')
  @HttpCode(HttpStatus.CREATED)
  createCategory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Body() dto: CreateMenuCategoryDto,
    @Req() request: Request,
  ): Promise<MenuCategoryView> {
    return this.menu.createCategory(merchantId, dto, toActor(user, request));
  }

  @Patch('categories/:categoryId')
  updateCategory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('categoryId', new ParseUUIDPipe()) categoryId: string,
    @Body() dto: UpdateMenuCategoryDto,
    @Req() request: Request,
  ): Promise<MenuCategoryView> {
    return this.menu.updateCategory(merchantId, categoryId, dto, toActor(user, request));
  }

  /**
   * Delete an empty category. Returns 409 `CATEGORY_IN_USE` with the item count
   * when dishes are still filed under it — move them first.
   */
  @Delete('categories/:categoryId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteCategory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('categoryId', new ParseUUIDPipe()) categoryId: string,
    @Req() request: Request,
  ): Promise<void> {
    return this.menu.deleteCategory(merchantId, categoryId, toActor(user, request));
  }

  // --------------------------------------------------------------------------
  //  Items
  // --------------------------------------------------------------------------

  @Post('items')
  @HttpCode(HttpStatus.CREATED)
  createItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Body() dto: CreateMenuItemDto,
    @Req() request: Request,
  ): Promise<MenuItemView> {
    return this.menu.createItem(merchantId, dto, toActor(user, request));
  }

  /**
   * Declared before `items/:itemId` — Nest matches routes in declaration order,
   * so the literal segment must come first or `order` would be read as a uuid.
   */
  @Put('items/order')
  @HttpCode(HttpStatus.OK)
  reorderItems(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Body() dto: ReorderMenuDto,
    @Req() request: Request,
  ): Promise<{ updated: number }> {
    return this.menu.reorderItems(merchantId, dto.entries, toActor(user, request));
  }

  @Patch('items/:itemId')
  updateItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() dto: UpdateMenuItemDto,
    @Req() request: Request,
  ): Promise<MenuItemView> {
    return this.menu.updateItem(merchantId, itemId, dto, toActor(user, request));
  }

  /** The one-tap switch on the kitchen screen: 售罄 / 恢復供應. */
  @Patch('items/:itemId/availability')
  setAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() dto: SetItemAvailabilityDto,
    @Req() request: Request,
  ): Promise<MenuItemView> {
    return this.menu.setAvailability(
      merchantId,
      itemId,
      dto.availability as MenuItemAvailability,
      toActor(user, request),
    );
  }

  /**
   * Remove a dish. Safe even when it appears on past orders: `order_items`
   * keeps its own name and price snapshots.
   */
  @Delete('items/:itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Req() request: Request,
  ): Promise<void> {
    return this.menu.deleteItem(merchantId, itemId, toActor(user, request));
  }
}
