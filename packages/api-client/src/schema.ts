export interface paths {
  '/api/v1/organizations': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['listOrganizations'];
    put?: never;
    post: operations['createOrganization'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/organizations/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getOrganization'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch: operations['renameOrganization'];
    trace?: never;
  };
  '/api/v1/organizations/{id}/audit': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['listAudit'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/organizations/{id}/members': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['listMembers'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/organizations/{id}/members/{user}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete: operations['removeMember'];
    options?: never;
    head?: never;
    patch: operations['changeRole'];
    trace?: never;
  };
  '/api/v1/organizations/{id}/members/{user}/events/{eventId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put: operations['assignEvent'];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/organizations/{id}/invitations': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['listInvitations'];
    put?: never;
    post: operations['createInvitation'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/organizations/{id}/invitations/{invitationId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete: operations['revokeInvitation'];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/invitations/accept': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations['acceptInvitation'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/organizations/{id}/events': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['listDrafts'];
    put?: never;
    post: operations['createDraft'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/organizations/{id}/events/{eventId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getDraft'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch: operations['updateDraft'];
    trace?: never;
  };
  '/api/v1/organizations/{id}/events/{eventId}/configuration': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put: operations['configureDraft'];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/organizations/{id}/events/{eventId}/cover': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['previewCover'];
    put?: never;
    post: operations['uploadCover'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/covers/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['publicCover'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/organizations/{id}/events/{eventId}/publication': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations['publishEvent'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/organizations/{id}/events/{eventId}/availability': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put: operations['changeSaleAvailability'];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/events': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['listPublicEvents'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/events/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getPublicEvent'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/organizations/{id}/events/{eventId}/publication/retry': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations['retryPublication'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/organizations/{id}/statistics': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getSalesStatistics'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/sales/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getPublicSale'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/orders': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['listMyOrders'];
    put?: never;
    post: operations['reserveOrder'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/orders/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getMyOrder'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/orders/{id}/cancel': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations['cancelMyOrder'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/auth/session': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getSession'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/auth/logout': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations['logout'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/auth/login': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['login'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/auth/callback': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['loginCallback'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/orders/{id}/payment-attempt': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations['createPaymentAttempt'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/orders/{id}/payment-status': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getPaymentStatus'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/orders/{id}/payment-attempt/fake-confirm': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations['confirmFakePayment'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/webhooks/stripe': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations['receiveStripeWebhook'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/check-in': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations['checkInTicket'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/orders/{id}/tickets': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['listOrderTickets'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/orders/{id}/tickets/{ticketId}/code': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getManualTicketCode'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/orders/{id}/tickets/{ticketId}/qr': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getOrderTicketQr'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: {
    ApiError: {
      code: string;
      message: string;
      requestId: string;
      retryable: boolean;
      fieldErrors?: {
        [key: string]: string[];
      };
    };
    /** @enum {string} */
    Role: 'OWNER' | 'MANAGER' | 'STAFF';
    Organization: {
      /** Format: uuid */
      id: string;
      name: string;
      role: components['schemas']['Role'];
    };
    OrganizationInput: {
      name: string;
    };
    Member: {
      userSubject: string;
      /** Format: email */
      email: string;
      role: components['schemas']['Role'];
      assignments: {
        /** Format: uuid */
        eventId: string;
      }[];
    };
    Invitation: {
      /** Format: uuid */
      id: string;
      /** Format: email */
      email: string;
      role: components['schemas']['Role'];
      /** Format: date-time */
      expiresAt: string;
      acceptedAt: string | null;
      revokedAt: string | null;
    };
    InvitationInput: {
      /** Format: email */
      email: string;
      /** @enum {string} */
      role: 'MANAGER' | 'STAFF';
    };
    InvitationCreated: {
      /** Format: uuid */
      id: string;
      token: string;
      /** Format: date-time */
      expiresAt: string;
    };
    Draft: {
      /** Format: uuid */
      id: string;
      /** Format: uuid */
      organizationId: string;
      title: string;
      description: string;
      /** Format: date-time */
      createdAt: string;
      revision: number;
      configuration: components['schemas']['EventConfiguration'] | null;
      /** Format: uuid */
      coverId: string | null;
      publication?: components['schemas']['Publication'] | null;
    };
    DraftInput: {
      title: string;
      description?: string;
    };
    AuditEntry: {
      /** Format: uuid */
      id: string;
      /** Format: uuid */
      organizationId: string;
      actorSubject: string;
      action: string;
      targetId: string;
      details: {
        [key: string]: unknown;
      };
      /** Format: date-time */
      createdAt: string;
    };
    PolicyQuery: {
      actorSubject: string;
      /** Format: uuid */
      organizationId: string;
      /** Format: uuid */
      eventId?: string;
      /** @enum {string} */
      action: 'events:read' | 'events:write' | 'members:manage' | 'check-in' | 'orders:refund';
    };
    EventConfiguration: {
      city: string;
      address: string;
      timeZone: string;
      /** Format: date-time */
      startsAt: string;
      /** Format: date-time */
      endsAt: string;
      /** Format: date-time */
      salesStartsAt: string;
      /** Format: date-time */
      salesEndsAt: string;
      /** Format: date-time */
      admissionStartsAt: string;
      /** Format: date-time */
      admissionEndsAt: string;
      /** @enum {string} */
      currency: 'EUR';
      categories: {
        id: string;
        name: string;
        priceMinor: number;
      }[];
      layout: {
        rows: number;
        columns: number;
        defaultCategoryId: string;
        overrides: {
          row: number;
          number: number;
          categoryId: string;
          disabled: boolean;
        }[];
      };
    };
    Publication: {
      /** Format: uuid */
      eventId: string;
      /** @constant */
      version: 1;
      /** @enum {string} */
      state: 'PROVISIONING' | 'PUBLISHED' | 'FAILED';
      snapshotHash: string;
      /** Format: date-time */
      requestedAt: string;
      /** Format: date-time */
      publishedAt: string | null;
      desiredPaused: boolean;
      acknowledgedPaused: boolean;
      commandVersion: number;
      acknowledgedVersion: number;
      attempt: number;
      /** @enum {string|null} */
      failureCode: 'SNAPSHOT_CONFLICT' | 'INVALID_SNAPSHOT' | null;
    };
    PublicEvent: {
      /** Format: uuid */
      id: string;
      title: string;
      description: string;
      city: string;
      address: string;
      timeZone: string;
      localDate: string;
      currency: string;
      /** Format: uuid */
      coverId: string | null;
      /** Format: date-time */
      startsAt: string;
      /** Format: date-time */
      endsAt: string;
      minPriceMinor: number;
      capacity: number;
    };
    PublicEventPage: {
      events: components['schemas']['PublicEvent'][];
      total: number;
      page: number;
      pageSize: number;
      pages: number;
    };
    SalesMetrics: {
      capacity: number;
      soldSeats: number;
      heldSeats: number;
      availableSeats: number;
      confirmedOrders: number;
      revenueMinor: number;
      paidMinor: number;
      refundedMinor: number;
      netMinor: number;
    };
    SalesEventStatistics: {
      /** Format: uuid */
      id: string;
      title: string;
      /** Format: date-time */
      startsAt: string;
      /** Format: date-time */
      updatedAt: string | null;
      capacity: number;
      soldSeats: number;
      heldSeats: number;
      availableSeats: number;
      confirmedOrders: number;
      revenueMinor: number;
      paidMinor: number;
      refundedMinor: number;
      netMinor: number;
    };
    SalesStatistics: {
      /** @enum {string} */
      currency: 'EUR';
      /** Format: date */
      from: string;
      /** Format: date */
      to: string;
      /** Format: date-time */
      asOf: string;
      /** Format: date-time */
      lastUpdatedAt: string | null;
      totals: components['schemas']['SalesMetrics'];
      events: components['schemas']['SalesEventStatistics'][];
      series: {
        /** Format: date */
        date: string;
        confirmedOrders: number;
        revenueMinor: number;
      }[];
      total: number;
      page: number;
      pageSize: number;
      pages: number;
    };
    PublicSale: {
      /** Format: uuid */
      id: string;
      /** @enum {string} */
      currency: 'EUR';
      /** @enum {string} */
      state: 'SCHEDULED' | 'OPEN' | 'PAUSED' | 'CLOSED';
      paused: boolean;
      commandVersion: number;
      seats: {
        seatId: string;
        categoryId: string;
        categoryName: string;
        row: number;
        number: number;
        priceMinor: number;
        /** @enum {string} */
        state: 'AVAILABLE' | 'HELD' | 'SOLD';
      }[];
      /** Format: date-time */
      serverNow: string;
      /** Format: date-time */
      salesStartsAt: string;
      /** Format: date-time */
      salesEndsAt: string;
    };
    Order: {
      /** Format: uuid */
      id: string;
      /** Format: uuid */
      saleId: string;
      title: string;
      /** @enum {string} */
      currency: 'EUR';
      totalMinor: number;
      /** @enum {string} */
      state: 'HELD' | 'CONFIRMED' | 'EXPIRED' | 'CANCELLED';
      /** Format: date-time */
      createdAt: string;
      /** Format: date-time */
      expiresAt: string;
      /** Format: date-time */
      serverNow: string;
      items: {
        seatId: string;
        categoryName: string;
        row: number;
        number: number;
        priceMinor: number;
      }[];
    };
    OrderList: {
      items: components['schemas']['Order'][];
      total: number;
      page: number;
      pageSize: number;
      /** Format: date-time */
      serverNow: string;
    };
    ReserveOrder: {
      /** Format: uuid */
      saleId: string;
      seatIds: string[];
    };
    PaymentOrder: {
      /** Format: uuid */
      orderId: string;
      buyerSubject: string;
      amountMinor: number;
      /** @constant */
      currency: 'EUR';
      /** Format: date-time */
      expiresAt: string;
      /** Format: date-time */
      serverNow: string;
      /** @enum {unknown} */
      state: 'HELD' | 'CONFIRMED' | 'EXPIRED' | 'CANCELLED';
    };
    Identity: {
      sub: string;
      email: string;
      emailVerified: boolean;
      name: string;
    };
    Session:
      | {
          user: null;
        }
      | {
          user: components['schemas']['Identity'];
          csrfToken: string;
        };
    PaymentAttemptReference: {
      /** Format: uuid */
      attemptId: string;
      /** Format: uuid */
      orderId: string;
    };
    PaymentStatus: {
      /** Format: uuid */
      attemptId: string;
      /** Format: uuid */
      orderId: string;
      /** @enum {unknown} */
      provider: 'fake' | 'stripe';
      /** @enum {unknown} */
      state:
        | 'CREATED'
        | 'REQUIRES_ACTION'
        | 'PROCESSING'
        | 'SUCCEEDED'
        | 'CANCELLED'
        | 'NEEDS_RECONCILIATION'
        | 'REQUIRES_REVIEW';
      /** @enum {unknown} */
      bookingState: 'PENDING' | 'CONFIRMED' | 'REFUND_PENDING' | 'REFUNDED' | 'REQUIRES_REVIEW';
      amountMinor: number;
      /** @constant */
      currency: 'EUR';
      /** @enum {unknown} */
      refundState: 'PENDING' | 'UNKNOWN' | 'SUCCEEDED' | 'REQUIRES_REVIEW' | null;
      reviewCode: string | null;
      canPay: boolean;
      clientSecret: string | null;
      publishableKey: string | null;
    };
    PaymentAccepted: {
      /** @constant */
      accepted: true;
    };
    CheckInInput: {
      /** Format: uuid */
      requestId: string;
      /** Format: uuid */
      organizationId: string;
      /** Format: uuid */
      eventId: string;
      credential: string;
    };
    CheckInResponse: {
      /** @enum {string} */
      result: 'ADMITTED' | 'ALREADY_USED' | 'WRONG_EVENT' | 'INVALID_TICKET' | 'WINDOW_CLOSED';
      /** Format: date-time */
      admittedAt: string | null;
    };
    OrderTicket: {
      /** Format: uuid */
      id: string;
      row: number;
      number: number;
      categoryName: string;
    };
  };
  responses: never;
  parameters: {
    TicketId: string;
    TicketOrderId: string;
  };
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
  listOrganizations: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            organizations: components['schemas']['Organization'][];
          };
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  createOrganization: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['OrganizationInput'];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Organization'];
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  getOrganization: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Organization'];
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  renameOrganization: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['OrganizationInput'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Organization'];
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  listAudit: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            entries: components['schemas']['AuditEntry'][];
          };
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  listMembers: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            members: components['schemas']['Member'][];
          };
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  removeMember: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
        user: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            userSubject: string;
            role: null;
          };
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  changeRole: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
        user: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          role: components['schemas']['Role'];
        };
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            userSubject: string;
            role: components['schemas']['Role'];
          };
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  assignEvent: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
        user: string;
        eventId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          assigned: boolean;
        };
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            assigned: boolean;
          };
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  listInvitations: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            invitations: components['schemas']['Invitation'][];
          };
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  createInvitation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['InvitationInput'];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['InvitationCreated'];
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  revokeInvitation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
        invitationId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            revoked: boolean;
          };
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  acceptInvitation: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          token: string;
        };
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            /** Format: uuid */
            organizationId: string;
            role: components['schemas']['Role'];
          };
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  listDrafts: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            events: components['schemas']['Draft'][];
          };
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  createDraft: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['DraftInput'];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Draft'];
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  getDraft: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
        eventId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Draft'];
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  updateDraft: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
        eventId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['DraftInput'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Draft'];
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  configureDraft: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
        eventId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          revision: number;
          configuration: components['schemas']['EventConfiguration'];
        };
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Draft'];
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  previewCover: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
        eventId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Validated WebP image */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'image/webp': Blob;
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  uploadCover: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
        eventId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'multipart/form-data': {
          /** Format: binary */
          file: Blob;
        };
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Draft'];
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  publicCover: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Validated WebP image */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'image/webp': Blob;
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  publishEvent: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
        eventId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          revision: number;
        };
      };
    };
    responses: {
      /** @description Publication requested or existing publication */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Publication'];
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  changeSaleAvailability: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
        eventId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          paused: boolean;
          expectedVersion: number;
        };
      };
    };
    responses: {
      /** @description Publication requested or existing publication */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Publication'];
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  listPublicEvents: {
    parameters: {
      query?: {
        q?: string;
        city?: string;
        from?: string;
        to?: string;
        page?: number;
        pageSize?: number;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PublicEventPage'];
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  getPublicEvent: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PublicEvent'];
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  retryPublication: {
    parameters: {
      query?: never;
      header: {
        'Idempotency-Key': string;
      };
      path: {
        id: string;
        eventId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          expectedAttempt: number;
        };
      };
    };
    responses: {
      /** @description Publication requested or existing publication */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Publication'];
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  getSalesStatistics: {
    parameters: {
      query?: {
        eventId?: string;
        from?: string;
        to?: string;
        page?: number;
        pageSize?: number;
      };
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SalesStatistics'];
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  getPublicSale: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PublicSale'];
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  listMyOrders: {
    parameters: {
      query?: {
        page?: number;
        saleId?: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['OrderList'];
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  reserveOrder: {
    parameters: {
      query?: never;
      header: {
        'Idempotency-Key': string;
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['ReserveOrder'];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Order'];
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  getMyOrder: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Order'];
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  cancelMyOrder: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Order'];
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  getSession: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Session'];
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  logout: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            /** Format: uri */
            logoutUrl: string;
          };
        };
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  login: {
    parameters: {
      query?: {
        returnTo?: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Redirect to Keycloak */
      302: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  loginCallback: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Redirect to application */
      303: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Request failed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiError'];
        };
      };
    };
  };
  createPaymentAttempt: {
    parameters: {
      query?: never;
      header: {
        'Idempotency-Key': string;
      };
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': Record<string, never>;
      };
    };
    responses: {
      /** @description Success */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PaymentAttemptReference'];
        };
      };
    };
  };
  getPaymentStatus: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PaymentStatus'];
        };
      };
    };
  };
  confirmFakePayment: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          /** @enum {unknown} */
          outcome: 'success' | 'decline' | 'processing';
        };
      };
    };
    responses: {
      /** @description Success */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PaymentAccepted'];
        };
      };
    };
  };
  receiveStripeWebhook: {
    parameters: {
      query?: never;
      header: {
        'Stripe-Signature': string;
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': Record<string, never>;
      };
    };
    responses: {
      /** @description Verified event durably recorded */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Invalid signature, event or environment */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
    };
  };
  checkInTicket: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['CheckInInput'];
      };
    };
    responses: {
      /** @description The authoritative admission result */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['CheckInResponse'];
        };
      };
    };
  };
  listOrderTickets: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: components['parameters']['TicketOrderId'];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Issued tickets for the authenticated buyer */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            tickets: components['schemas']['OrderTicket'][];
          };
        };
      };
      /** @description No tickets available to this buyer */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
    };
  };
  getManualTicketCode: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: components['parameters']['TicketOrderId'];
        ticketId: components['parameters']['TicketId'];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The ticket credential for authorized manual entry */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            code: string;
          };
        };
      };
    };
  };
  getOrderTicketQr: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: components['parameters']['TicketOrderId'];
        ticketId: components['parameters']['TicketId'];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Private, non-cacheable ticket QR image */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'image/png': Blob;
        };
      };
      /** @description No matching ticket available to this buyer */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
    };
  };
}
