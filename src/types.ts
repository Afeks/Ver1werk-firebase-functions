/**
 * TypeScript Typen und Interfaces für OrderCat Firebase Functions
 */

export enum DistributionMode {
  BALANCED = 'balanced',
  GROUPED = 'grouped'
}

export interface Item {
  id: string;
  name?: string;
  price?: number;
  count?: number;
  category?: string;
  categoryName?: string;
  soldOut?: boolean;
  isAvailable?: boolean;
  selectedExtras?: string[];
  excludedIngredients?: string[];
}

export interface ServingPoint {
  id: string;
  name: string;
  location: string;
  areaName?: string;
  capacity: number;
}

export interface PointOfSale {
  id: string;
  name: string;
  description?: string;
  location: string;
  availableItems: Item[];
  openOrders?: any[];
}

export interface Purchase {
  id: string;
  items: Item[];
  eventId: string;
  userId?: string;
  servingPoint?: ServingPoint;
  orderStatus?: string;
  orderPlaced?: Date;
  orderDone?: Date;
  note?: string;
}

export interface DistributedPurchase {
  id: string;
  orderDate?: Date;
  orderDone?: Date;
  orderStatus: string;
  servingPointName?: string;
  servingPointLocation?: string;
  items: Item[];
  note?: string;
  tabletNumber?: string;
}

export interface DistributeOrderRequest {
  eventId: string;
  items: Item[];
  servingPoint: ServingPoint;
  userId?: string;
  distributionMode?: DistributionMode;
  note?: string;
}

export interface DistributeOrderResponse {
  success: boolean;
  purchaseId: string;
  distributedPurchases: {
    pointOfSaleId: string;
    pointOfSaleName: string;
    orderId: string;
    itemsCount: number;
  }[];
  error?: string;
}

