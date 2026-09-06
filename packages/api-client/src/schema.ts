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
      action: 'events:read' | 'events:write' | 'members:manage' | 'check-in';
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
  };
  responses: never;
  parameters: never;
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
}
